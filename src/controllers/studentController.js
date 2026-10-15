const asyncHandler = require('express-async-handler');
const Student = require('../models/Student');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const TransportAssignment = require('../models/TransportAssignment');
const StudentFeeSubscription = require('../models/StudentFeeSubscription');
const { confirmStudentTransportAssignment, ensureBaselineAssignments } = require('../services/capacityService');
const { geocodeAddress } = require('../services/mapProviderService');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all students
// @route   GET /api/students/:companyId
// @access  Private/Admin
const getStudents = asyncHandler(async (req, res) => {
    await ensureBaselineAssignments(req.params.companyId);
    const students = await Student.find({ company: req.params.companyId })
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats')
        .populate('assignedRoute', 'name code shift plannedKm')
        .populate('activeFeePlan', 'code name frequency amount')
        .sort({ createdAt: -1 })
        .lean();
    res.json(students);
});

// @desc    Create student
// @route   POST /api/students
// @access  Private/Admin
const createStudent = asyncHandler(async (req, res) => {
    const {
        name,
        className,
        batch,
        rollNumber,
        company,
        assignedBus,
        assignedRoute,
        assignedSeatNumber,
        pickupLocationName,
        originalAddress,
        pickupLat,
        pickupLng,
        contactNumber,
        parentName,
        feeAmount,
        feeType,
        financialYear,
        activeFeePlan,
        shift,
        tripDirection,
        effectiveFrom
    } = req.body;

    let resolvedLat = pickupLat !== undefined && pickupLat !== '' ? Number(pickupLat) : null;
    let resolvedLng = pickupLng !== undefined && pickupLng !== '' ? Number(pickupLng) : null;
    let normAddr = originalAddress || pickupLocationName || '';
    let geocodeStatus = resolvedLat && resolvedLng ? 'ManualPin' : 'Missing';

    if ((!resolvedLat || !resolvedLng) && (originalAddress || pickupLocationName)) {
        try {
            const geo = await geocodeAddress(originalAddress || pickupLocationName);
            resolvedLat = geo.lat;
            resolvedLng = geo.lng;
            normAddr = geo.normalizedAddress;
            geocodeStatus = geo.geocodeStatus;
        } catch (e) {
            // Keep null if geocoding fails
        }
    }

    const student = await Student.create({
        name,
        className,
        batch,
        rollNumber,
        company,
        assignedBus: assignedBus || null,
        assignedRoute: assignedRoute || null,
        assignedSeatNumber: assignedSeatNumber || null,
        pickupLocationName: pickupLocationName || originalAddress || '',
        originalAddress: originalAddress || pickupLocationName || '',
        normalizedAddress: normAddr,
        geocodeStatus,
        pickupLat: resolvedLat,
        pickupLng: resolvedLng,
        contactNumber,
        parentName,
        feeAmount: Number(feeAmount) || 0,
        feeType: feeType || 'Monthly',
        financialYear,
        activeFeePlan: activeFeePlan || null,
        shift: shift || 'Both',
        tripDirection: tripDirection || 'Two-Way',
        effectiveFrom: effectiveFrom || new Date()
    });

    if (assignedBus) {
        try {
            const assignedRes = await confirmStudentTransportAssignment({
                companyId: company,
                studentId: student._id,
                busId: assignedBus,
                routeId: assignedRoute || null,
                stopName: pickupLocationName || originalAddress || 'Assigned Stop',
                pickupLat: resolvedLat,
                pickupLng: resolvedLng,
                seatNumber: assignedSeatNumber || null,
                shift: shift || 'Both',
                direction: tripDirection || 'Two-Way',
                effectiveFrom: effectiveFrom || new Date(),
                feePlanId: activeFeePlan || null,
                overrideAmount: feeAmount || null,
                changeReason: 'Initial Student Enrollment',
                user: req.user
            });
            const populated = await Student.findById(assignedRes.student._id)
                .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats')
                .populate('assignedRoute', 'name code shift')
                .populate('activeFeePlan', 'code name frequency amount');
            return res.status(201).json(populated);
        } catch (assignErr) {
            // Rollback student creation if bus was full so transactional integrity holds
            await Student.findByIdAndDelete(student._id);
            res.status(assignErr.statusCode || 400);
            throw assignErr;
        }
    }

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

    const { assignedBus, assignedRoute, assignedSeatNumber, effectiveFrom, changeReason, activeFeePlan, feeAmount } = req.body;
    const busChanged = assignedBus !== undefined && String(student.assignedBus || '') !== String(assignedBus || '');
    const routeChanged = assignedRoute !== undefined && String(student.assignedRoute || '') !== String(assignedRoute || '');

    // If bus or route assignment is being set/changed, use transactional effective-dated assignment engine
    if (assignedBus && (busChanged || routeChanged)) {
        await confirmStudentTransportAssignment({
            companyId: student.company,
            studentId: student._id,
            busId: assignedBus,
            routeId: assignedRoute || student.assignedRoute || null,
            stopName: req.body.pickupLocationName || student.pickupLocationName,
            pickupLat: req.body.pickupLat !== undefined ? req.body.pickupLat : student.pickupLat,
            pickupLng: req.body.pickupLng !== undefined ? req.body.pickupLng : student.pickupLng,
            seatNumber: assignedSeatNumber || null,
            shift: req.body.shift || student.shift || 'Both',
            direction: req.body.tripDirection || student.tripDirection || 'Two-Way',
            effectiveFrom: effectiveFrom || new Date(),
            feePlanId: activeFeePlan || student.activeFeePlan || null,
            overrideAmount: feeAmount !== undefined ? feeAmount : student.feeAmount,
            changeReason: changeReason || 'Route/Bus Reassignment',
            user: req.user
        });
    } else if (assignedBus && assignedSeatNumber && (student.assignedBus?.toString() !== assignedBus || student.assignedSeatNumber !== assignedSeatNumber)) {
        const existing = await Student.findOne({ assignedBus, assignedSeatNumber });
        if (existing && existing._id.toString() !== req.params.id) {
            res.status(400);
            throw new Error(`Seat ${assignedSeatNumber} is already assigned on this bus`);
        }
    }

    const updated = await Student.findByIdAndUpdate(req.params.id, req.body, { new: true })
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats')
        .populate('assignedRoute', 'name code shift')
        .populate('activeFeePlan', 'code name frequency amount');
    res.json(updated);
});

// @desc    Delete / Withdraw student
// @route   DELETE /api/students/:id
// @access  Private/Admin
const deleteStudent = asyncHandler(async (req, res) => {
    const student = await Student.findById(req.params.id);
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }

    // Close active effective-dated assignments rather than destroying history
    await TransportAssignment.updateMany(
        { student: student._id, status: 'Active', effectiveTo: null },
        { $set: { effectiveTo: new Date(), status: 'Withdrawn', changeReason: 'Student Removed/Withdrawn' } }
    );
    await StudentFeeSubscription.updateMany(
        { student: student._id, status: 'Active', effectiveTo: null },
        { $set: { effectiveTo: new Date(), status: 'Withdrawn' } }
    );

    await logAudit({
        company: student.company,
        user: req.user,
        action: 'STUDENT_WITHDRAWN_OR_REMOVED',
        entityType: 'Student',
        entityId: student._id,
        beforeState: { name: student.name, assignedBus: student.assignedBus },
        reason: 'Student removed from active roster (historical assignments preserved)'
    });

    await student.deleteOne();
    res.json({ message: 'Student removed (historical transport records preserved)' });
});

module.exports = {
    getStudents,
    createStudent,
    updateStudent,
    deleteStudent
};
