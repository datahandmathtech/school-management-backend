const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const Student = require('../models/Student');
const TransportAssignment = require('../models/TransportAssignment');
const StudentFeeSubscription = require('../models/StudentFeeSubscription');
const FeePlan = require('../models/FeePlan');
const { roundMoney, subMoney, divMoney } = require('../utils/moneyUtils');
const { logAudit } = require('../utils/auditLogger');

/**
 * Parse numeric capacity from bus object (seatingCapacity or busType fallback)
 */
const resolveTotalSeats = (bus) => {
    if (!bus) return 0;
    if (Number(bus.seatingCapacity) > 0) return Number(bus.seatingCapacity);
    if (bus.busType) {
        const match = String(bus.busType).match(/(\d+)/);
        if (match) return Number(match[1]);
    }
    return 35;
};

const baselineSyncedCompanies = new Set();

/**
 * Ensures any legacy Student record with assignedBus has an active TransportAssignment
 * and StudentFeeSubscription so historical and computed capacity engines stay 100% consistent.
 */
const ensureBaselineAssignments = async (companyId, force = false) => {
    const key = String(companyId);
    if (!force && baselineSyncedCompanies.has(key)) return;

    const [studentsWithBus, routes, activeAssignments, activeSubs] = await Promise.all([
        Student.find({
            company: companyId,
            assignedBus: { $ne: null },
            status: { $nin: ['inactive', 'withdrawn'] },
            transportStatus: { $nin: ['Withdrawn', 'Non-Transport'] }
        }).lean(),
        Route.find({ company: companyId }).lean(),
        TransportAssignment.find({
            company: companyId,
            status: 'Active',
            effectiveTo: null
        }).select('student').lean(),
        StudentFeeSubscription.find({
            company: companyId,
            status: 'Active',
            effectiveTo: null
        }).select('student').lean()
    ]);

    if (!studentsWithBus.length) {
        baselineSyncedCompanies.add(key);
        return;
    }

    const assignedStudentSet = new Set(activeAssignments.map(a => String(a.student)));
    const subStudentSet = new Set(activeSubs.map(s => String(s.student)));

    const busToRouteMap = {};
    routes.forEach(r => {
        if (r.assignedBus) busToRouteMap[String(r.assignedBus)] = r;
    });

    for (const stu of studentsWithBus) {
        const stuIdStr = String(stu._id);

        if (!assignedStudentSet.has(stuIdStr)) {
            const matchedRoute = stu.assignedRoute
                ? routes.find(r => String(r._id) === String(stu.assignedRoute))
                : busToRouteMap[String(stu.assignedBus)];

            const assignment = await TransportAssignment.create({
                company: companyId,
                student: stu._id,
                bus: stu.assignedBus,
                route: matchedRoute ? matchedRoute._id : null,
                stopName: stu.pickupLocationName || 'Assigned Stop',
                pickupLat: stu.pickupLat || null,
                pickupLng: stu.pickupLng || null,
                seatNumber: stu.assignedSeatNumber || null,
                shift: stu.shift || 'Both',
                direction: stu.tripDirection || 'Two-Way',
                effectiveFrom: stu.effectiveFrom || stu.createdAt || new Date('2026-04-01'),
                effectiveTo: null,
                status: 'Active',
                changeReason: 'Baseline Onboarding Sync'
            });

            await Student.findByIdAndUpdate(stu._id, {
                activeAssignment: assignment._id,
                assignedRoute: matchedRoute ? matchedRoute._id : stu.assignedRoute
            });
        }

        if (!subStudentSet.has(stuIdStr) && Number(stu.feeAmount) > 0) {
            const freq = stu.feeType || 'Monthly';
            const stdAmt = roundMoney(stu.feeAmount);
            const monthlyEq = freq === 'Annual' || freq === 'Yearly'
                ? divMoney(stdAmt, 12)
                : freq === 'Half-Yearly' || freq === 'Term'
                    ? divMoney(stdAmt, 6)
                    : freq === 'Quarterly'
                        ? divMoney(stdAmt, 3)
                        : stdAmt;

            const sub = await StudentFeeSubscription.create({
                company: companyId,
                student: stu._id,
                feePlan: stu.activeFeePlan || null,
                bus: stu.assignedBus,
                route: stu.assignedRoute || (busToRouteMap[String(stu.assignedBus)]?._id || null),
                stopName: stu.pickupLocationName || '',
                frequency: freq === 'Yearly' ? 'Annual' : freq,
                standardAmount: stdAmt,
                netPeriodicAmount: stdAmt,
                monthlyEquivalentAmount: monthlyEq,
                effectiveFrom: stu.effectiveFrom || stu.createdAt || new Date('2026-04-01'),
                effectiveTo: null,
                status: 'Active'
            });

            await Student.findByIdAndUpdate(stu._id, { activeSubscription: sub._id });
        }
    }

    baselineSyncedCompanies.add(key);
};

/**
 * Compute capacity metrics for a single bus given active assignments count
 */
const computeBusCapacityMetrics = (bus, occupiedCount, nearlyFullThreshold = 90) => {
    const totalSeats = resolveTotalSeats(bus);
    const reservedSeats = Math.max(0, Number(bus?.reservedSeats) || 0);
    const usableCapacity = Math.max(0, totalSeats - reservedSeats);
    const occupiedSeats = Math.max(0, Number(occupiedCount) || 0);
    const availableSeats = usableCapacity - occupiedSeats; // Can be negative if over capacity
    const occupancyPercent = usableCapacity > 0
        ? Number(((occupiedSeats / usableCapacity) * 100).toFixed(1))
        : 0;

    const isOverCapacity = occupiedSeats > usableCapacity;
    const isFull = availableSeats <= 0;

    let capacityStatus = 'Available';
    if (isOverCapacity) {
        capacityStatus = 'Over Capacity';
    } else if (isFull) {
        capacityStatus = 'Full';
    } else if (occupancyPercent >= nearlyFullThreshold) {
        capacityStatus = 'Nearly Full';
    } else if (occupancyPercent < 50 && occupiedSeats > 0) {
        capacityStatus = 'Underutilized';
    } else if (occupiedSeats === 0) {
        capacityStatus = 'Empty';
    }

    return {
        totalSeats,
        reservedSeats,
        reservedStaffSeats: reservedSeats,
        usableCapacity,
        occupiedSeats,
        availableSeats: Math.max(0, availableSeats),
        rawAvailableSeats: availableSeats,
        overCapacityCount: isOverCapacity ? occupiedSeats - usableCapacity : 0,
        occupancyPercent,
        occupancyPct: occupancyPercent,
        isFull,
        isOverCapacity,
        capacityStatus
    };
};

/**
 * Get active student assignments for a company as of a target date (default now)
 */
const getActiveAssignmentsAsOf = async (companyId, asOfDate = new Date(), shift = null) => {
    await ensureBaselineAssignments(companyId);

    const query = {
        company: companyId,
        effectiveFrom: { $lte: asOfDate },
        $or: [
            { effectiveTo: null },
            { effectiveTo: { $gte: asOfDate } }
        ],
        status: 'Active'
    };

    if (shift && shift !== 'Both' && shift !== 'All') {
        query.shift = { $in: [shift, 'Both'] };
    }

    return await TransportAssignment.find(query)
        .populate('student', 'name className batch rollNumber contactNumber parentName feeAmount feeType pickupLocationName pickupLat pickupLng status transportStatus')
        .populate('bus', 'carNumber displayCode busType seatingCapacity reservedSeats status')
        .populate('route', 'name code shift plannedKm plannedMinutes')
        .lean();
};

/**
 * Compute fleet-wide capacity snapshot for all school buses in a company
 */
const getFleetCapacitySnapshot = async (companyId, { asOfDate = new Date(), shift = null, nearlyFullThreshold = 90 } = {}) => {
    const [buses, routes, activeAssignments] = await Promise.all([
        Vehicle.find({
            company: companyId,
            isOutsideCar: { $ne: true },
            carType: { $in: ['Bus', 'Mini Bus', 'Traveler', 'Electric Vehicle', 'SUV'] }
        })
            .populate('currentDriver', 'name mobile salary')
            .populate('assignedConductor', 'name mobile salary')
            .populate('routeAssigned', 'name code plannedKm plannedMinutes shift stops')
            .lean(),
        Route.find({ company: companyId }).lean(),
        getActiveAssignmentsAsOf(companyId, asOfDate, shift)
    ]);

    // Filter to school buses primarily (if explicit displayCode buses exist, prioritize them, otherwise all Bus/Mini Bus)
    const explicitCodedBuses = buses.filter(b => b.displayCode && b.displayCode.startsWith('BUS-'));
    const schoolBuses = explicitCodedBuses.length >= 3
        ? explicitCodedBuses
        : buses.filter(b => b.carType === 'Bus' || b.carType === 'Mini Bus');
    const targetBuses = (schoolBuses.length > 0 ? schoolBuses : buses).sort((a, b) =>
        String(a.displayCode || 'ZZZ').localeCompare(String(b.displayCode || 'ZZZ'))
    );

    const busAssignmentsMap = {};
    activeAssignments.forEach(a => {
        if (!a.student || a.student.status === 'inactive' || a.student.transportStatus === 'Withdrawn') return;
        const bId = String(a.bus?._id || a.bus);
        if (!busAssignmentsMap[bId]) busAssignmentsMap[bId] = [];
        busAssignmentsMap[bId].push(a);
    });

    const routeByBusMap = {};
    routes.forEach(r => {
        if (r.assignedBus) routeByBusMap[String(r.assignedBus)] = r;
    });

    let totalFleetSeats = 0;
    let totalReservedSeats = 0;
    let totalUsableCapacity = 0;
    let totalOccupiedSeats = 0;
    let totalAvailableSeats = 0;

    const busSnapshots = targetBuses.map((bus, index) => {
        const bId = String(bus._id);
        const assignedList = busAssignmentsMap[bId] || [];
        const linkedRoute = routeByBusMap[bId] || bus.routeAssigned || null;
        const cap = computeBusCapacityMetrics(bus, assignedList.length, nearlyFullThreshold);

        totalFleetSeats += cap.totalSeats;
        totalReservedSeats += cap.reservedSeats;
        totalUsableCapacity += cap.usableCapacity;
        totalOccupiedSeats += cap.occupiedSeats;
        totalAvailableSeats += cap.availableSeats;

        return {
            ...bus,
            displayCode: bus.displayCode || `BUS-L${String(index + 1).padStart(2, '0')}`,
            activeRoute: linkedRoute,
            capacity: cap,
            activeAssignments: assignedList
        };
    });

    const fleetUtilizationPercent = totalUsableCapacity > 0
        ? Number(((totalOccupiedSeats / totalUsableCapacity) * 100).toFixed(1))
        : 0;

    return {
        summary: {
            fleetSize: busSnapshots.length,
            totalFleetSeats,
            totalReservedSeats,
            totalUsableCapacity,
            totalOccupiedSeats,
            totalAvailableSeats,
            fleetUtilizationPercent,
            fullBusesCount: busSnapshots.filter(b => b.capacity.isFull).length,
            overCapacityBusesCount: busSnapshots.filter(b => b.capacity.isOverCapacity).length,
            spareCapacityBusesCount: busSnapshots.filter(b => b.capacity.availableSeats > 0).length
        },
        buses: busSnapshots
    };
};

/**
 * Transactional Student Transport Assignment & Fee Subscription Confirmation (Section 12 & 21, AC-17, AC-18)
 * - Re-checks capacity inside transaction / atomic check
 * - Closes prior active TransportAssignment and StudentFeeSubscription without destroying history
 * - Creates new effective-dated TransportAssignment and StudentFeeSubscription
 * - Updates Student snapshot fields and writes AuditLog
 */
const confirmStudentTransportAssignment = async ({
    companyId,
    studentId,
    busId,
    routeId = null,
    stopId = null,
    stopName = '',
    pickupLat = null,
    pickupLng = null,
    pickupTime = '07:30 AM',
    seatNumber = null,
    shift = 'Both',
    direction = 'Two-Way',
    effectiveFrom = new Date(),
    feePlanId = null,
    overrideAmount = null,
    discountType = 'None',
    discountAmount = 0,
    overrideReason = '',
    changeReason = 'Operator Confirmed Assignment',
    optimizationRunId = null,
    user = null
}) => {
    const effDate = effectiveFrom ? new Date(effectiveFrom) : new Date();

    const executeCore = async (session = null) => {
        const opts = session ? { session } : {};

        const [student, bus] = await Promise.all([
            Student.findOne({ _id: studentId, company: companyId }, null, opts),
            Vehicle.findOne({ _id: busId, company: companyId }, null, opts)
        ]);

        if (!student) {
            const err = new Error('Student not found in school');
            err.statusCode = 404;
            throw err;
        }
        if (!bus) {
            const err = new Error('Target bus not found in school fleet');
            err.statusCode = 404;
            throw err;
        }
        if (bus.status === 'inactive') {
            const err = new Error(`Bus ${bus.carNumber} is inactive and cannot accept assignments`);
            err.statusCode = 400;
            throw err;
        }

        // Resolve route if not explicitly passed
        let resolvedRouteId = routeId;
        let routeDoc = null;
        if (resolvedRouteId) {
            routeDoc = await Route.findOne({ _id: resolvedRouteId, company: companyId }, null, opts);
        } else {
            routeDoc = await Route.findOne({ company: companyId, assignedBus: bus._id, isActive: true }, null, opts);
            if (routeDoc) resolvedRouteId = routeDoc._id;
        }

        // Re-check current active assignments on target bus (excluding this student if already on this bus)
        const activeOnBus = await TransportAssignment.find({
            company: companyId,
            bus: bus._id,
            student: { $ne: student._id },
            status: 'Active',
            effectiveFrom: { $lte: effDate },
            $or: [{ effectiveTo: null }, { effectiveTo: { $gte: effDate } }]
        }, null, opts);

        const capMetrics = computeBusCapacityMetrics(bus, activeOnBus.length);
        if (capMetrics.availableSeats <= 0) {
            const err = new Error(
                `Capacity Constraint Violation: Bus ${bus.displayCode || bus.carNumber} is full (${capMetrics.occupiedSeats}/${capMetrics.usableCapacity} usable seats occupied). Assignment rejected.`
            );
            err.statusCode = 409;
            throw err;
        }

        // Auto-select or validate seat number
        let finalSeatNumber = seatNumber ? Number(seatNumber) : null;
        const takenSeats = new Set(activeOnBus.map(a => a.seatNumber).filter(Boolean));
        if (finalSeatNumber && takenSeats.has(finalSeatNumber)) {
            const err = new Error(`Seat #${finalSeatNumber} is already occupied on Bus ${bus.carNumber}`);
            err.statusCode = 409;
            throw err;
        }
        if (!finalSeatNumber) {
            for (let s = 1; s <= capMetrics.usableCapacity; s++) {
                if (!takenSeats.has(s)) {
                    finalSeatNumber = s;
                    break;
                }
            }
        }

        // Close any previous active assignment for this student (effective-dated history preservation)
        const priorAssignments = await TransportAssignment.find({
            company: companyId,
            student: student._id,
            status: 'Active',
            effectiveTo: null
        }, null, opts);

        const closeDate = new Date(effDate.getTime() - 1000);
        for (const prior of priorAssignments) {
            prior.effectiveTo = closeDate > prior.effectiveFrom ? closeDate : effDate;
            prior.status = 'Closed';
            await prior.save(opts);
        }

        // Create new effective-dated TransportAssignment
        const [newAssignment] = await TransportAssignment.create([{
            company: companyId,
            student: student._id,
            bus: bus._id,
            route: resolvedRouteId,
            stop: stopId || null,
            stopName: stopName || student.pickupLocationName || 'Assigned Pickup Point',
            pickupLat: pickupLat !== null ? Number(pickupLat) : student.pickupLat,
            pickupLng: pickupLng !== null ? Number(pickupLng) : student.pickupLng,
            pickupTime,
            seatNumber: finalSeatNumber,
            shift: shift || student.shift || 'Both',
            direction: direction || student.tripDirection || 'Two-Way',
            effectiveFrom: effDate,
            effectiveTo: null,
            status: 'Active',
            changeReason,
            optimizationRun: optimizationRunId || null,
            createdBy: user?._id || null
        }], opts);

        // Determine fee plan & subscription pricing
        let feePlanDoc = null;
        if (feePlanId) {
            feePlanDoc = await FeePlan.findOne({ _id: feePlanId, company: companyId }, null, opts);
        } else if (student.activeFeePlan) {
            feePlanDoc = await FeePlan.findOne({ _id: student.activeFeePlan, company: companyId }, null, opts);
        } else if (resolvedRouteId) {
            feePlanDoc = await FeePlan.findOne({ company: companyId, route: resolvedRouteId, status: 'Active' }, null, opts);
        }

        const frequency = feePlanDoc?.frequency || (student.feeType === 'Yearly' ? 'Annual' : student.feeType) || 'Monthly';
        const standardAmt = roundMoney(
            feePlanDoc
                ? (direction === 'One-Way' && feePlanDoc.oneWayAmount > 0 ? feePlanDoc.oneWayAmount : feePlanDoc.amount)
                : (routeDoc?.defaultFeeAmount || student.feeAmount || 2000)
        );
        const hasOverride = overrideAmount !== null && overrideAmount !== undefined && overrideAmount !== '';
        const baseForNet = hasOverride ? roundMoney(overrideAmount) : standardAmt;
        const discAmt = roundMoney(discountAmount || 0);
        const netPeriodicAmt = Math.max(0, subMoney(baseForNet, discAmt));

        const monthlyEquivalentAmt = frequency === 'Annual'
            ? divMoney(netPeriodicAmt, 12)
            : frequency === 'Half-Yearly' || frequency === 'Term'
                ? divMoney(netPeriodicAmt, 6)
                : frequency === 'Quarterly'
                    ? divMoney(netPeriodicAmt, 3)
                    : netPeriodicAmt;

        // Close prior active fee subscriptions
        const priorSubs = await StudentFeeSubscription.find({
            company: companyId,
            student: student._id,
            status: 'Active',
            effectiveTo: null
        }, null, opts);

        for (const sub of priorSubs) {
            sub.effectiveTo = closeDate > sub.effectiveFrom ? closeDate : effDate;
            sub.status = 'Closed';
            await sub.save(opts);
        }

        const [newSubscription] = await StudentFeeSubscription.create([{
            company: companyId,
            student: student._id,
            feePlan: feePlanDoc?._id || null,
            assignment: newAssignment._id,
            bus: bus._id,
            route: resolvedRouteId,
            stopName: newAssignment.stopName,
            tripType: direction === 'One-Way' ? 'One-Way' : 'Two-Way',
            frequency,
            standardAmount: standardAmt,
            overrideAmount: hasOverride ? roundMoney(overrideAmount) : null,
            discountType: discountType || 'None',
            discountAmount: discAmt,
            netPeriodicAmount: netPeriodicAmt,
            monthlyEquivalentAmount: monthlyEquivalentAmt,
            overrideReason: overrideReason || '',
            approvedBy: (hasOverride || discAmt > 0) ? (user?._id || null) : null,
            effectiveFrom: effDate,
            effectiveTo: null,
            status: 'Active'
        }], opts);

        // Update Student current pointers for compatibility
        const beforeStudentState = {
            assignedBus: student.assignedBus,
            assignedRoute: student.assignedRoute,
            assignedSeatNumber: student.assignedSeatNumber,
            feeAmount: student.feeAmount
        };

        student.assignedBus = bus._id;
        student.assignedRoute = resolvedRouteId;
        student.assignedSeatNumber = finalSeatNumber;
        student.pickupLocationName = newAssignment.stopName;
        if (pickupLat !== null && pickupLat !== undefined && pickupLat !== '') student.pickupLat = Number(pickupLat);
        if (pickupLng !== null && pickupLng !== undefined && pickupLng !== '') student.pickupLng = Number(pickupLng);
        student.activeFeePlan = feePlanDoc?._id || student.activeFeePlan;
        student.activeSubscription = newSubscription._id;
        student.activeAssignment = newAssignment._id;
        student.feeAmount = monthlyEquivalentAmt;
        student.transportStatus = 'Active';
        student.status = 'active';
        student.effectiveFrom = effDate;
        await student.save(opts);

        return {
            student,
            assignment: newAssignment,
            subscription: newSubscription,
            capacityAfter: computeBusCapacityMetrics(bus, activeOnBus.length + 1),
            beforeStudentState
        };
    };

    const result = await executeCore(null);

    await logAudit({
        company: companyId,
        user,
        action: 'STUDENT_TRANSPORT_ASSIGNED',
        entityType: 'TransportAssignment',
        entityId: result.assignment._id,
        beforeState: result.beforeStudentState,
        afterState: {
            studentId,
            busId,
            routeId: result.assignment.route,
            seatNumber: result.assignment.seatNumber,
            effectiveFrom: result.assignment.effectiveFrom,
            monthlyEquivalentFee: result.subscription.monthlyEquivalentAmount
        },
        reason: changeReason
    });

    return result;
};

module.exports = {
    resolveTotalSeats,
    ensureBaselineAssignments,
    computeBusCapacityMetrics,
    getActiveAssignmentsAsOf,
    getFleetCapacitySnapshot,
    confirmStudentTransportAssignment
};
