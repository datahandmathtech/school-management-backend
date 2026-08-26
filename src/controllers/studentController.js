const asyncHandler = require('express-async-handler');
const Student = require('../models/Student');
const Vehicle = require('../models/Vehicle');

// @desc    Get all students
// @route   GET /api/students/:companyId
// @access  Private/Admin
const getStudents = asyncHandler(async (req, res) => {
    const students = await Student.find({ company: req.params.companyId })
                                  .populate('assignedBus', 'carNumber busType')
                                  .sort({ createdAt: -1 })
                                  .lean();
    res.json(students);
});

// @desc    Create student
// @route   POST /api/students
// @access  Private/Admin
const createStudent = asyncHandler(async (req, res) => {
    const { name, className, batch, rollNumber, company, assignedBus, assignedSeatNumber, pickupLocationName, pickupLat, pickupLng, contactNumber, parentName, feeAmount, feeType, financialYear } = req.body;
    
    // Check if seat is taken
    if (assignedBus && assignedSeatNumber) {
        const existing = await Student.findOne({ assignedBus, assignedSeatNumber });
        if (existing) {
            res.status(400);
            throw new Error(`Seat ${assignedSeatNumber} is already assigned on this bus`);
        }
    }

    const student = await Student.create({
        name, className, batch, rollNumber, company, assignedBus, assignedSeatNumber, pickupLocationName, pickupLat, pickupLng, contactNumber, parentName, feeAmount, feeType, financialYear
    });

    res.status(201).json(student);
});

// @desc    Update student
// @route   PUT /api/students/:id
// @access  Private/Admin
const updateStudent = asyncHandler(async (req, res) => {
    const student = await Student.findById(req.params.id);
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }

    const { assignedBus, assignedSeatNumber } = req.body;

    if (assignedBus && assignedSeatNumber && (student.assignedBus?.toString() !== assignedBus || student.assignedSeatNumber !== assignedSeatNumber)) {
        const existing = await Student.findOne({ assignedBus, assignedSeatNumber });
        if (existing && existing._id.toString() !== req.params.id) {
            res.status(400);
            throw new Error(`Seat ${assignedSeatNumber} is already assigned on this bus`);
        }
    }

    const updated = await Student.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('assignedBus', 'carNumber busType');
    res.json(updated);
});

// @desc    Delete student
// @route   DELETE /api/students/:id
// @access  Private/Admin
const deleteStudent = asyncHandler(async (req, res) => {
    const student = await Student.findById(req.params.id);
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }
    await student.deleteOne();
    res.json({ message: 'Student removed' });
});

module.exports = {
    getStudents,
    createStudent,
    updateStudent,
    deleteStudent
};
