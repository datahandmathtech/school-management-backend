const express = require('express');
const router = express.Router();
const FeeRecord = require('../models/FeeRecord');
const Student = require('../models/Student');
const { protect } = require('../middleware/authMiddleware');

// Get fee records for a company (with month/year filters)
router.get('/:companyId', protect, async (req, res) => {
    try {
        const { month, year } = req.query;
        let query = { company: req.params.companyId };
        if (month) query.month = month;
        if (year) query.year = Number(year);

        const fees = await FeeRecord.find(query).populate('student', 'name className rollNumber').sort('-createdAt');
        res.json(fees);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Update or Create a fee record for a student
router.post('/pay', protect, async (req, res) => {
    const { studentId, month, year, amountPaid, companyId } = req.body;
    try {
        const student = await Student.findById(studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        let feeRecord = await FeeRecord.findOne({ student: studentId, month, year });
        
        const totalFee = student.feeAmount || 0;

        if (feeRecord) {
            feeRecord.amountPaid += Number(amountPaid);
            feeRecord.amountPending = Math.max(0, totalFee - feeRecord.amountPaid);
            feeRecord.status = feeRecord.amountPending <= 0 ? 'Paid' : (feeRecord.amountPaid > 0 ? 'Partial' : 'Pending');
            feeRecord.paymentDate = new Date();
            await feeRecord.save();
        } else {
            const amountPending = Math.max(0, totalFee - Number(amountPaid));
            feeRecord = await FeeRecord.create({
                student: studentId,
                company: companyId,
                month,
                year,
                amountPaid: Number(amountPaid),
                amountPending,
                status: amountPending <= 0 ? 'Paid' : (Number(amountPaid) > 0 ? 'Partial' : 'Pending'),
                paymentDate: new Date()
            });
        }
        res.status(200).json(feeRecord);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Get dashboard summary
router.get('/summary/:companyId', protect, async (req, res) => {
    try {
        const { month, year } = req.query;
        if (!month || !year) return res.status(400).json({ message: 'Month and year required' });

        const fees = await FeeRecord.find({ company: req.params.companyId, month, year: Number(year) }).populate('student', 'name className');
        
        let totalCollected = 0;
        let totalPending = 0;
        
        fees.forEach(f => {
            totalCollected += f.amountPaid;
            totalPending += f.amountPending;
        });

        // Get students who haven't paid at all (no FeeRecord)
        const allStudents = await Student.find({ company: req.params.companyId });
        const studentsWithRecord = new Set(fees.map(f => f.student._id.toString()));
        
        let unaccountedPending = 0;
        const pendingStudents = [];
        
        allStudents.forEach(s => {
            if (!studentsWithRecord.has(s._id.toString())) {
                unaccountedPending += (s.feeAmount || 0);
                if (s.feeAmount > 0) {
                    pendingStudents.push({
                        _id: s._id,
                        name: s.name,
                        className: s.className,
                        amountPending: s.feeAmount
                    });
                }
            }
        });
        
        fees.forEach(f => {
            if (f.amountPending > 0) {
                pendingStudents.push({
                    _id: f.student._id,
                    name: f.student.name,
                    className: f.student.className,
                    amountPending: f.amountPending
                });
            }
        });

        res.json({
            totalCollected,
            totalPending: totalPending + unaccountedPending,
            pendingStudents
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
