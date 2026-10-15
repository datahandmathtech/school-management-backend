const asyncHandler = require('express-async-handler');
const Company = require('../models/Company');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const Stop = require('../models/Stop');
const Student = require('../models/Student');
const TransportAssignment = require('../models/TransportAssignment');
const FeePlan = require('../models/FeePlan');
const StudentFeeSubscription = require('../models/StudentFeeSubscription');
const TransportDemand = require('../models/TransportDemand');
const TransportReceipt = require('../models/TransportReceipt');
const ReceiptAllocation = require('../models/ReceiptAllocation');
const TransportLedgerEntry = require('../models/TransportLedgerEntry');
const TransportExpense = require('../models/TransportExpense');
const PayrollAllocation = require('../models/PayrollAllocation');
const FixedCostSchedule = require('../models/FixedCostSchedule');
const OdometerLog = require('../models/OdometerLog');
const OptimizationRun = require('../models/OptimizationRun');
const AuditLog = require('../models/AuditLog');
const Fuel = require('../models/Fuel');
const Maintenance = require('../models/Maintenance');
const User = require('../models/User');

const {
    roundMoney,
    addMoney,
    subMoney,
    mulMoney,
    divMoney,
    parsePeriod
} = require('../utils/moneyUtils');
const { logAudit } = require('../utils/auditLogger');
const {
    ensureBaselineAssignments,
    getFleetCapacitySnapshot,
    confirmStudentTransportAssignment
} = require('../services/capacityService');
const {
    recomputeStudentRunningBalance,
    generatePeriodDemands,
    applyDemandAdjustment,
    postTransportReceipt,
    allocateExistingReceipt,
    issueTransportRefund,
    getStudentTransportLedger,
    getCollectionsOverview
} = require('../services/financeEngineService');
const { calculateTransportProfitability } = require('../services/profitabilityService');
const {
    geocodeAddress,
    autocompleteAddress,
    calculateRouteGeometry,
    calculateInsertionDetour
} = require('../services/mapProviderService');
const { evaluateRouteRecommendations } = require('../services/routeOptimizerService');

const resolveCompanyId = (req) => {
    return (
        req.params?.companyId ||
        req.params?.id ||
        req.query?.companyId ||
        req.body?.companyId ||
        req.body?.company ||
        req.user?.company?._id ||
        req.user?.company
    );
};

// 1. GET /api/transport/dashboard (and /api/transport/dashboard/:companyId)
const getTransportDashboard = asyncHandler(async (req, res) => {
    const companyId = req.params.companyId || req.query.companyId || req.user?.company?._id || req.user?.company;
    if (!companyId) {
        res.status(400);
        throw new Error('companyId is required');
    }

    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const [profitability, collections] = await Promise.all([
        calculateTransportProfitability(companyId, { period, month, year }),
        getCollectionsOverview(companyId, { period, month, year })
    ]);

    // Build Route Health summary counts
    const routeHealth = {
        full: profitability.busSummary.filter(b => b.capacity.isFull && !b.capacity.isOverCapacity).length,
        overCapacity: profitability.busSummary.filter(b => b.capacity.isOverCapacity).length,
        nearlyFull: profitability.busSummary.filter(b => b.statusFlags.includes('Nearly Full')).length,
        underutilized: profitability.busSummary.filter(b => b.statusFlags.includes('Underutilized')).length,
        lossMaking: profitability.busSummary.filter(b => b.operatingContribution < 0).length,
        healthy: profitability.busSummary.filter(b => b.overallHealth === 'Healthy').length
    };

    const schoolSummary = {
        ...profitability.schoolSummary,
        advanceBalance: collections.kpis.advanceBalance,
        overdueStudentsCount: collections.kpis.overdueStudentsCount,
        collectionEfficiencyPercent: collections.kpis.collectionEfficiencyPercent
    };

    res.json({
        periodKey: profitability.periodKey,
        month: profitability.month,
        year: profitability.year,
        kpis: schoolSummary,
        schoolSummary,
        fleetSnapshot: profitability.busSummary,
        busStatements: profitability.busSummary,
        routeSummary: profitability.routeSummary,
        routeStatements: profitability.routeSummary,
        routeHealth,
        costMix: profitability.costMix,
        agingBuckets: collections.agingBuckets,
        collections,
        topOverdueDemands: collections.openDemands.slice(0, 8),
        alerts: profitability.alerts,
        metadata: profitability.metadata
    });
});

// 2. GET /api/transport/schools/:companyId/fleet
const getSchoolFleet = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const profitability = await calculateTransportProfitability(companyId, { period, month, year });

    res.json({
        periodKey: profitability.periodKey,
        summary: profitability.schoolSummary,
        buses: profitability.busSummary
    });
});

const getSchoolFleetArray = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const profitability = await calculateTransportProfitability(companyId, { period, month, year });
    res.json(profitability.busSummary);
});

// 3. GET /api/transport/buses/:id (Complete 9-Tab Bus Detail)
const getBusDetail = asyncHandler(async (req, res) => {
    const bus = await Vehicle.findById(req.params.id)
        .populate('currentDriver', 'name mobile salary licenseNumber')
        .populate('assignedConductor', 'name mobile salary')
        .populate('routeAssigned')
        .lean();

    if (!bus) {
        res.status(404);
        throw new Error('Bus not found');
    }

    const companyId = bus.company;
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const p = parsePeriod(period, month, year);

    const [
        profitability,
        activeAssignments,
        assignmentHistory,
        busDemands,
        busFuelLogs,
        busMaintenance,
        busExpenses,
        busFixedCosts,
        busPayroll,
        routeDoc
    ] = await Promise.all([
        calculateTransportProfitability(companyId, { period, month, year }),
        TransportAssignment.find({
            company: companyId,
            bus: bus._id,
            status: 'Active',
            effectiveTo: null
        })
            .populate('student', 'name className batch rollNumber contactNumber parentName pickupLocationName pickupLat pickupLng feeAmount feeType')
            .populate('route', 'name code shift')
            .sort({ seatNumber: 1 })
            .lean(),
        TransportAssignment.find({
            company: companyId,
            bus: bus._id
        })
            .populate('student', 'name className batch rollNumber')
            .populate('route', 'name code')
            .sort({ effectiveFrom: -1 })
            .limit(50)
            .lean(),
        TransportDemand.find({
            company: companyId,
            attributedBus: bus._id,
            periodKey: p.periodKey,
            status: { $nin: ['Cancelled', 'Reversed'] }
        })
            .populate('student', 'name className batch rollNumber contactNumber')
            .populate('feePlan', 'code name frequency')
            .lean(),
        Fuel.find({ vehicle: bus._id }).sort({ date: -1 }).limit(30).lean(),
        Maintenance.find({ vehicle: bus._id }).sort({ billDate: -1 }).limit(30).lean(),
        TransportExpense.find({ company: companyId, bus: bus._id, status: 'Posted' }).sort({ expenseDate: -1 }).limit(40).lean(),
        FixedCostSchedule.find({ company: companyId, bus: bus._id }).sort({ createdAt: -1 }).lean(),
        PayrollAllocation.find({ company: companyId, 'splits.bus': bus._id }).sort({ periodKey: -1 }).limit(20).lean(),
        Route.findOne({ company: companyId, assignedBus: bus._id }).lean()
    ]);

    const busFinancials = profitability.busSummary.find(b => String(b.busId) === String(bus._id)) || null;

    res.json({
        bus,
        route: routeDoc || bus.routeAssigned || null,
        financials: busFinancials,
        profitability: busFinancials,
        students: activeAssignments,
        demands: busDemands,
        fuelLogs: busFuelLogs,
        maintenanceJobs: busMaintenance,
        expenses: busExpenses,
        fixedCostSchedules: busFixedCosts,
        payrollAllocations: busPayroll,
        assignmentHistory
    });
});

// 4. GET /api/transport/buses/:id/financials
const getBusFinancials = asyncHandler(async (req, res) => {
    const bus = await Vehicle.findById(req.params.id).lean();
    if (!bus) {
        res.status(404);
        throw new Error('Bus not found');
    }
    const { period, month, year } = req.query;
    const profitability = await calculateTransportProfitability(bus.company, { period, month, year });
    const busFin = profitability.busSummary.find(b => String(b.busId) === String(bus._id));
    res.json({
        periodKey: profitability.periodKey,
        busFinancials: busFin || null
    });
});

// 5. GET /api/transport/routes/:id (Complete Route Detail + Stop Timeline + Cumulative Occupancy)
const getRouteDetail = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id)
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats currentDriver status')
        .lean();

    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }

    const company = await Company.findById(route.company).lean();
    const { period, month, year } = req.query;

    const [profitability, activeAssignments] = await Promise.all([
        calculateTransportProfitability(route.company, { period, month, year }),
        TransportAssignment.find({
            company: route.company,
            $or: [
                { route: route._id },
                ...(route.assignedBus ? [{ bus: route.assignedBus._id || route.assignedBus }] : [])
            ],
            status: 'Active',
            effectiveTo: null
        })
            .populate('student', 'name className batch rollNumber contactNumber parentName pickupLocationName pickupLat pickupLng feeAmount')
            .lean()
    ]);

    const routeFinancials = profitability.routeSummary.find(r => String(r.routeId) === String(route._id)) || null;
    const usableCapacity = routeFinancials?.usableCapacity || Number(route.assignedBus?.seatingCapacity) || 35;

    // Build Stop Timeline with boarding students & cumulative occupancy
    let cumulativeOccupancy = 0;
    const stopTimeline = (route.stops || []).map((stop, idx) => {
        const boardingStudents = activeAssignments.filter(a => {
            const stuStop = (a.stopName || a.student?.pickupLocationName || '').toLowerCase().trim();
            return stuStop === (stop.stopName || '').toLowerCase().trim();
        });
        cumulativeOccupancy += boardingStudents.length;
        return {
            sequence: stop.sequence || idx + 1,
            stopName: stop.stopName,
            address: stop.address || stop.stopName,
            lat: stop.lat,
            lng: stop.lng,
            expectedTime: stop.expectedTime || `${7 + Math.floor((idx * 10) / 60)}:${String((15 + idx * 10) % 60).padStart(2, '0')} AM`,
            distanceFromStartKm: stop.distanceFromStartKm || Number((idx * 2.4).toFixed(1)),
            boardingCount: boardingStudents.length,
            boardingStudents: boardingStudents.map(b => b.student),
            cumulativeOccupancy,
            remainingSeatsAfterStop: Math.max(0, usableCapacity - cumulativeOccupancy)
        };
    });

    const geomInfo = calculateRouteGeometry(route.stops || [], {
        lat: company?.schoolLat || 26.9124,
        lng: company?.schoolLng || 75.7873
    });

    res.json({
        route: {
            ...route,
            plannedKm: route.plannedKm || geomInfo.plannedKm,
            plannedMinutes: route.plannedMinutes || geomInfo.plannedMinutes,
            geometry: route.geometry?.length > 0 ? route.geometry : geomInfo.geometry
        },
        schoolLocation: {
            name: company?.name || 'School Campus',
            lat: company?.schoolLat || 26.9124,
            lng: company?.schoolLng || 75.7873
        },
        financials: routeFinancials,
        stopTimeline,
        activeAssignments
    });
});

// 6. GET /api/transport/routes/:id/financials
const getRouteFinancials = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id).lean();
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }
    const { period, month, year } = req.query;
    const profitability = await calculateTransportProfitability(route.company, { period, month, year });
    const routeFin = profitability.routeSummary.find(r => String(r.routeId) === String(route._id));
    res.json({
        periodKey: profitability.periodKey,
        routeFinancials: routeFin || null
    });
});

// 7. Fee Plan Master Endpoints
const getFeePlans = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const plans = await FeePlan.find({ company: companyId })
        .populate('route', 'name code shift')
        .sort({ createdAt: -1 });
    res.json(plans.map(p => p.toJSON()));
});

const createFeePlan = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const {
        code,
        name,
        basis,
        route,
        zoneOrBandName,
        minDistanceKm,
        maxDistanceKm,
        frequency,
        amount,
        oneWayAmount,
        twoWayAmount,
        effectiveFrom,
        effectiveTo,
        prorationRule,
        taxPercent,
        lateFeeAmount,
        dueDayOfMonth,
        discountRules
    } = req.body;

    const plan = await FeePlan.create({
        company: companyId,
        code: code || `FP-${Date.now().toString().slice(-4)}`,
        name,
        basis: basis || 'Route',
        route: route || null,
        zoneOrBandName: zoneOrBandName || '',
        minDistanceKm: Number(minDistanceKm) || 0,
        maxDistanceKm: Number(maxDistanceKm) || 50,
        frequency: frequency || 'Monthly',
        amount: roundMoney(amount),
        oneWayAmount: roundMoney(oneWayAmount || (Number(amount) * 0.65)),
        twoWayAmount: roundMoney(twoWayAmount || amount),
        effectiveFrom: effectiveFrom || new Date('2026-04-01'),
        effectiveTo: effectiveTo || null,
        prorationRule: prorationRule || 'DailyProrata',
        taxPercent: Number(taxPercent) || 0,
        lateFeeAmount: roundMoney(lateFeeAmount || 0),
        dueDayOfMonth: Number(dueDayOfMonth) || 10,
        discountRules: discountRules || [],
        createdBy: req.user?._id || null
    });

    await logAudit({
        company: companyId,
        user: req.user,
        action: 'FEE_PLAN_CREATED',
        entityType: 'FeePlan',
        entityId: plan._id,
        afterState: plan.toJSON(),
        reason: 'Created Transport Fee Plan'
    });

    res.status(201).json(plan.toJSON());
});

const updateFeePlan = asyncHandler(async (req, res) => {
    const plan = await FeePlan.findById(req.params.id);
    if (!plan) {
        res.status(404);
        throw new Error('Fee plan not found');
    }
    const beforeState = plan.toJSON();
    Object.assign(plan, req.body);
    await plan.save();

    await logAudit({
        company: plan.company,
        user: req.user,
        action: 'FEE_PLAN_UPDATED',
        entityType: 'FeePlan',
        entityId: plan._id,
        beforeState,
        afterState: plan.toJSON(),
        reason: req.body.reason || 'Updated Fee Plan'
    });

    res.json(plan.toJSON());
});

// 8. POST /api/transport/students/:id/transport-subscription (and POST /api/transport/:companyId/assignments/confirm)
const createStudentSubscriptionAndAssignment = asyncHandler(async (req, res) => {
    const studentId = req.params.id || req.body.studentId;
    const student = await Student.findById(studentId);
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }

    const companyId = req.params.companyId || student.company;
    const overrideAmt = req.body.overrideAmount !== undefined
        ? req.body.overrideAmount
        : req.body.monthlyFee !== undefined
            ? req.body.monthlyFee
            : undefined;

    const result = await confirmStudentTransportAssignment({
        companyId,
        studentId: student._id,
        busId: req.body.busId || req.body.assignedBus || student.assignedBus,
        routeId: req.body.routeId || req.body.assignedRoute || student.assignedRoute,
        stopId: req.body.stopId || null,
        stopName: req.body.stopName || req.body.pickupLocationName || student.pickupLocationName,
        pickupLat: req.body.pickupLat !== undefined ? req.body.pickupLat : student.pickupLat,
        pickupLng: req.body.pickupLng !== undefined ? req.body.pickupLng : student.pickupLng,
        pickupTime: req.body.pickupTime || '07:30 AM',
        seatNumber: req.body.seatNumber || req.body.assignedSeatNumber || null,
        shift: req.body.shift || student.shift || 'Both',
        direction: req.body.direction || req.body.tripDirection || 'Two-Way',
        effectiveFrom: req.body.effectiveFrom || new Date(),
        feePlanId: req.body.feePlanId || student.activeFeePlan || null,
        overrideAmount: overrideAmt,
        discountType: req.body.discountType || 'None',
        discountAmount: req.body.discountAmount || req.body.discountValue || 0,
        overrideReason: req.body.overrideReason || req.body.customOverrideReason || '',
        changeReason: req.body.changeReason || req.body.reason || 'Operator Confirmed Transport Assignment & Subscription',
        optimizationRunId: req.body.optimizationRunId || null,
        user: req.user
    });

    if (req.body.optimizationRunId) {
        await OptimizationRun.findByIdAndUpdate(req.body.optimizationRunId, {
            selectedBus: result.assignment.bus,
            selectedRoute: result.assignment.route,
            decisionStatus: 'Confirmed'
        });
    }

    res.status(201).json({
        message: 'Student transport assignment and fee subscription confirmed',
        student: result.student,
        assignment: result.assignment,
        subscription: result.subscription.toJSON(),
        capacityAfter: result.capacityAfter,
        updatedBusCapacity: result.capacityAfter
    });
});

// 8b. GET /api/transport/:companyId/subscriptions
const getSubscriptions = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const { activeOnly = 'true', studentId } = req.query;
    const query = { company: companyId };
    if (activeOnly !== 'false') {
        query.status = 'Active';
        query.effectiveTo = null;
    }
    if (studentId) query.student = studentId;

    const subs = await StudentFeeSubscription.find(query)
        .populate('student', 'name rollNumber className batch contactNumber parentName assignedBus assignedRoute pickupLocationName')
        .populate('feePlan', 'name code baseAmount frequency')
        .populate('bus', 'carNumber displayCode')
        .populate('route', 'name code')
        .sort({ effectiveFrom: -1 });

    res.json(subs.map(s => {
        const json = s.toJSON();
        return {
            ...json,
            monthlyFee: json.finalAmount,
            baseFeeAmount: json.baseAmount,
            discountValue: json.discountAmount,
            customOverrideReason: json.overrideReason
        };
    }));
});

// 8c. GET /api/transport/:companyId/assignments
const getAssignments = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const { studentId, busId, routeId, activeOnly = 'false' } = req.query;
    const query = { company: companyId };
    if (studentId) query.student = studentId;
    if (busId) query.bus = busId;
    if (routeId) query.route = routeId;
    if (activeOnly === 'true') {
        query.status = 'Active';
        query.effectiveTo = null;
    }

    const assignments = await TransportAssignment.find(query)
        .populate('student', 'name rollNumber className batch contactNumber parentName')
        .populate('bus', 'carNumber displayCode')
        .populate('route', 'name code')
        .sort({ effectiveFrom: -1 });

    res.json(assignments.map(a => {
        const json = a.toJSON();
        return {
            ...json,
            bus: json.bus ? { ...json.bus, busNumber: json.bus.displayCode || json.bus.carNumber } : null,
            route: json.route ? { ...json.route, routeName: json.route.name, routeCode: json.route.code } : null
        };
    }));
});

// 9. Withdraw or Suspend Student Transport (Effective-Dated, Preserving History)
const updateStudentTransportStatus = asyncHandler(async (req, res) => {
    const student = await Student.findById(req.params.id);
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }

    const { action = 'Withdrawn', effectiveDate = new Date(), reason = 'Student transport withdrawal' } = req.body;
    const effDate = new Date(effectiveDate);

    await TransportAssignment.updateMany(
        { company: student.company, student: student._id, status: 'Active', effectiveTo: null },
        { $set: { effectiveTo: effDate, status: action === 'Suspended' ? 'Suspended' : 'Withdrawn' } }
    );

    await StudentFeeSubscription.updateMany(
        { company: student.company, student: student._id, status: 'Active', effectiveTo: null },
        { $set: { effectiveTo: effDate, status: action === 'Suspended' ? 'Suspended' : 'Withdrawn' } }
    );

    if (action === 'Withdrawn') {
        student.assignedBus = null;
        student.assignedSeatNumber = null;
        student.transportStatus = 'Withdrawn';
    } else {
        student.transportStatus = 'Suspended';
    }
    await student.save();

    await logAudit({
        company: student.company,
        user: req.user,
        action: `STUDENT_TRANSPORT_${action.toUpperCase()}`,
        entityType: 'Student',
        entityId: student._id,
        afterState: { transportStatus: student.transportStatus, effectiveDate: effDate },
        reason
    });

    res.json({ message: `Student transport status updated to ${action}`, student });
});

// 10. POST /api/transport/billing/generate (and POST /api/transport/:companyId/demands/generate)
const generateBilling = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.body.period || req.body.periodKey;
    const { month, year, studentId, applyProration = true } = req.body;
    const result = await generatePeriodDemands({
        companyId,
        period,
        month,
        year,
        studentId,
        applyProration,
        user: req.user
    });
    res.status(201).json({
        ...result,
        generatedCount: (result.createdCount || 0) + (result.skippedCount || 0)
    });
});

// 11. GET /api/transport/demands/:companyId (and GET /api/transport/:companyId/demands)
const getDemands = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year, status, studentId } = req.query;
    const query = { company: companyId };

    if (period || month) {
        const p = parsePeriod(period, month, year);
        query.periodKey = p.periodKey;
    }
    if (status && status !== 'All') query.status = status;
    if (studentId) query.student = studentId;

    const demands = await TransportDemand.find(query)
        .populate('student', 'name className batch rollNumber contactNumber parentName')
        .populate('attributedBus', 'carNumber displayCode')
        .populate('attributedRoute', 'name code')
        .populate('feePlan', 'code name frequency')
        .sort({ createdAt: -1 });

    res.json(demands.map(d => {
        const json = d.toJSON();
        const totalWaiver = addMoney(json.discountAmount || 0, json.waiverAmount || 0, json.creditAdjustment || 0);
        const isProrated = Number(json.prorationFactor || 1) < 1 || !!json.isProrated;
        const baseAmount = isProrated && Number(json.prorationFactor) > 0
            ? divMoney(json.grossAmount, json.prorationFactor)
            : json.grossAmount;
        return {
            ...json,
            invoiceNumber: json.demandNo,
            bus: json.attributedBus
                ? { ...json.attributedBus, busNumber: json.attributedBus.displayCode || json.attributedBus.carNumber }
                : null,
            route: json.attributedRoute
                ? { ...json.attributedRoute, routeName: json.attributedRoute.name, routeCode: json.attributedRoute.code }
                : null,
            baseAmount,
            proratedAmount: isProrated ? json.grossAmount : null,
            isProrated,
            prorationNote: json.prorationCalculationNote || (isProrated ? 'Prorated mid-period enrollment' : ''),
            waiverAmount: totalWaiver,
            paidAmount: json.allocatedAmount || 0,
            balanceAmount: json.outstandingAmount || 0
        };
    }));
});

// 12. POST /api/transport/demands/:id/adjust (Debit/Credit Adjustment or Waiver)
const adjustDemand = asyncHandler(async (req, res) => {
    const demandId = req.params.demandId || req.params.id;
    const demand = await TransportDemand.findById(demandId);
    if (!demand) {
        res.status(404);
        throw new Error('Demand not found');
    }
    const rawType = req.body.adjustmentType || req.body.type || 'CreditAdjustment';
    const adjustmentType = rawType === 'Debit' ? 'DebitAdjustment' : rawType === 'Credit' ? 'CreditAdjustment' : rawType;

    const updated = await applyDemandAdjustment({
        companyId: demand.company,
        demandId: demand._id,
        adjustmentType,
        amount: req.body.amount,
        reason: req.body.reason,
        user: req.user
    });
    res.json(updated.toJSON());
});

// 13. POST /api/transport/demands/opening-balance (Migrate Opening Receivable / Advance)
const postOpeningBalance = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const {
        studentId,
        type = 'Receivable',
        amount,
        periodKey,
        asOfDate = new Date('2026-04-01'),
        notes = req.body.reason || 'Opening Balance Migration'
    } = req.body;

    const amt = roundMoney(amount);
    if (amt <= 0) {
        res.status(400);
        throw new Error('Opening balance amount must be greater than 0');
    }

    const student = await Student.findOne({ _id: studentId, company: companyId });
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }

    const d = new Date(asOfDate);
    const p = periodKey ? parsePeriod(periodKey) : parsePeriod(null, d.getMonth() + 1, d.getFullYear());

    if (type === 'Advance') {
        const receipt = await postTransportReceipt({
            companyId,
            studentId: student._id,
            amount: amt,
            receiptDate: d,
            paymentMode: 'Other',
            referenceNo: 'OPENING-ADV',
            notes,
            autoAllocateFIFO: true,
            user: req.user
        });
        return res.status(201).json(receipt);
    }

    const demandNo = `OB-${p.periodKey.replace('-', '')}-${String(student._id).slice(-4).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
    const demand = await TransportDemand.create({
        company: companyId,
        demandNo,
        student: student._id,
        attributedBus: student.assignedBus,
        attributedRoute: student.assignedRoute,
        periodKey: p.periodKey,
        month: p.monthName,
        year: p.year,
        grossAmount: amt,
        netAmount: amt,
        allocatedAmount: 0,
        outstandingAmount: amt,
        dueDate: d,
        isOpeningBalance: true,
        status: 'Pending',
        createdBy: req.user?._id || null
    });

    await TransportLedgerEntry.create({
        company: companyId,
        student: student._id,
        entryDate: d,
        periodKey: p.periodKey,
        entryType: 'OpeningBalance',
        referenceType: 'TransportDemand',
        referenceId: demand._id,
        referenceNo: demand.demandNo,
        description: `Opening Receivable Balance (${notes})`,
        debit: amt,
        credit: 0,
        runningBalance: 0,
        reason: notes,
        actor: req.user?._id || null
    });

    await recomputeStudentRunningBalance(companyId, student._id);
    res.status(201).json(demand.toJSON());
});

// 14. Collections, Receipts, Allocations & Refunds
const getCollections = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const query = {
        ...req.query,
        period: req.query.period || req.query.periodKey
    };
    const result = await getCollectionsOverview(companyId, query);
    res.json(result);
});

const getReceipts = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const receipts = await TransportReceipt.find({ company: companyId, status: { $ne: 'Reversed' } })
        .populate('student', 'name className batch rollNumber contactNumber parentName')
        .sort({ receiptDate: -1 })
        .limit(100);

    res.json(receipts.map(r => {
        const json = r.toJSON();
        return {
            ...json,
            receiptNumber: json.receiptNo,
            paymentDate: json.receiptDate,
            appliedAmount: json.allocatedAmount || 0,
            advanceAmount: json.unallocatedAdvanceAmount || 0,
            advanceBalance: json.unallocatedAdvanceAmount || 0
        };
    }));
});

const createReceipt = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const result = await postTransportReceipt({
        companyId,
        studentId: req.body.studentId || req.body.student,
        amount: req.body.amount,
        receiptDate: req.body.receiptDate || req.body.paymentDate,
        paymentMode: req.body.paymentMode,
        referenceNo: req.body.referenceNo || req.body.referenceNumber,
        bankOrCashAccount: req.body.bankOrCashAccount || req.body.bankAccount,
        notes: req.body.notes || req.body.remarks,
        allocations: req.body.allocations,
        autoAllocateFIFO: req.body.autoAllocateFIFO !== false,
        idempotencyKey: req.body.idempotencyKey || req.headers['x-idempotency-key'] || null,
        user: req.user
    });
    res.status(result.duplicateIdempotent ? 200 : 201).json(result);
});

const allocateReceipt = asyncHandler(async (req, res) => {
    const receipt = await TransportReceipt.findById(req.params.id);
    if (!receipt) {
        res.status(404);
        throw new Error('Receipt not found');
    }
    const result = await allocateExistingReceipt({
        companyId: receipt.company,
        receiptId: receipt._id,
        allocations: req.body.allocations || [],
        user: req.user
    });
    res.json(result);
});

const createRefund = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const result = await issueTransportRefund({
        companyId,
        studentId: req.body.studentId || req.body.student,
        receiptId: req.body.receiptId,
        amount: req.body.amount,
        paymentMode: req.body.paymentMode,
        referenceNo: req.body.referenceNo,
        reason: req.body.reason,
        user: req.user
    });
    res.status(201).json(result);
});

const getStudentLedger = asyncHandler(async (req, res) => {
    const studentId = req.params.studentId || req.params.id;
    const student = await Student.findById(studentId).lean();
    if (!student) {
        res.status(404);
        throw new Error('Student not found');
    }
    const ledger = await getStudentTransportLedger(student.company, student._id);
    res.json({
        ...ledger,
        billedTotal: ledger.summary?.totalBilled || 0,
        collectedTotal: ledger.summary?.totalCollected || 0,
        outstandingTotal: ledger.summary?.netOutstanding || 0,
        advanceTotal: ledger.summary?.advanceBalance || 0,
        invoices: (ledger.demands || []).map(d => ({
            ...d,
            invoiceNumber: d.demandNo,
            paidAmount: d.allocatedAmount || 0,
            balanceAmount: d.outstandingAmount || 0
        }))
    });
});

// 15. Expenses, Payroll Allocations, Fixed Cost Schedules & Fuel/Maintenance/Odometer
const getExpensesAndCosts = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const p = parsePeriod(period, month, year);

    const [expenses, payrolls, fixedSchedules, fuelLogs, maintenanceJobs, odometerLogs] = await Promise.all([
        TransportExpense.find({ company: companyId, periodKey: p.periodKey, status: 'Posted' })
            .populate('bus', 'carNumber displayCode')
            .populate('route', 'name code')
            .sort({ expenseDate: -1 }),
        PayrollAllocation.find({ company: companyId, periodKey: p.periodKey })
            .populate('splits.bus', 'carNumber displayCode')
            .populate('splits.route', 'name code')
            .sort({ createdAt: -1 }),
        FixedCostSchedule.find({ company: companyId, status: 'Active' })
            .populate('bus', 'carNumber displayCode')
            .sort({ createdAt: -1 }),
        Fuel.find({ company: companyId, date: { $gte: p.startDate, $lte: p.endDate } })
            .populate('vehicle', 'carNumber displayCode')
            .sort({ date: -1 })
            .lean(),
        Maintenance.find({ company: companyId, billDate: { $gte: p.startDate, $lte: p.endDate } })
            .populate('vehicle', 'carNumber displayCode')
            .sort({ billDate: -1 })
            .lean(),
        OdometerLog.find({ company: companyId, periodKey: p.periodKey })
            .populate('bus', 'carNumber displayCode')
            .sort({ date: -1 })
            .lean()
    ]);

    res.json({
        periodKey: p.periodKey,
        month: p.monthName,
        year: p.year,
        expenses: expenses.map(e => e.toJSON()),
        unallocatedExpenses: expenses.filter(e => e.allocationTargetType === 'Unallocated').map(e => e.toJSON()),
        payrollAllocations: payrolls.map(pa => pa.toJSON()),
        fixedCostSchedules: fixedSchedules.map(fc => fc.toJSON()),
        fuelLogs,
        maintenanceJobs,
        odometerLogs
    });
});

const getExpensesOnly = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const p = parsePeriod(period, month, year);

    const expenses = await TransportExpense.find({ company: companyId, periodKey: p.periodKey, status: 'Posted' })
        .populate('bus', 'carNumber displayCode')
        .populate('route', 'name code')
        .sort({ expenseDate: -1 });

    res.json(expenses.map(e => {
        const json = e.toJSON();
        const costType = json.allocationTargetType === 'Unallocated'
            ? 'Unallocated'
            : json.allocationTargetType === 'Shared'
                ? 'Shared'
                : json.costClassification || 'DirectVariable';
        return {
            ...json,
            costType,
            sharedAllocationBasis: json.sharedAllocationMethod,
            vendorName: json.vendor,
            bus: json.bus ? { ...json.bus, busNumber: json.bus.displayCode || json.bus.carNumber } : null,
            route: json.route ? { ...json.route, routeName: json.route.name, routeCode: json.route.code } : null
        };
    }));
});

const getPayrollOnly = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year } = req.query;
    const p = parsePeriod(period, month, year);

    const payrolls = await PayrollAllocation.find({ company: companyId, periodKey: p.periodKey })
        .populate('splits.bus', 'carNumber displayCode')
        .populate('splits.route', 'name code')
        .sort({ createdAt: -1 });

    res.json(payrolls.map(pa => {
        const json = pa.toJSON();
        return {
            ...json,
            staffName: json.employeeName,
            grossSalary: json.fixedPay,
            allocations: (json.splits || []).map(s => ({
                ...s,
                bus: s.bus ? { ...s.bus, busNumber: s.bus.displayCode || s.bus.carNumber } : null,
                route: s.route ? { ...s.route, routeName: s.route.name } : null,
                splitPct: s.percentage
            }))
        };
    }));
});

const getFixedSchedulesOnly = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const schedules = await FixedCostSchedule.find({ company: companyId })
        .populate('bus', 'carNumber displayCode')
        .sort({ createdAt: -1 });

    res.json(schedules.map(fc => {
        const json = fc.toJSON();
        return {
            ...json,
            bus: json.bus ? { ...json.bus, busNumber: json.bus.displayCode || json.bus.carNumber } : null,
            startDate: json.serviceStartDate,
            endDate: json.serviceEndDate,
            totalMonths: json.monthsCovered,
            paidDate: json.cashPaymentDate
        };
    }));
});

const createExpense = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const expDate = req.body.expenseDate ? new Date(req.body.expenseDate) : new Date();
    const p = parsePeriod(req.body.periodKey, expDate.getMonth() + 1, expDate.getFullYear());

    const rawCostType = req.body.costType || '';
    const allocationTargetType = req.body.allocationTargetType ||
        (rawCostType === 'Unallocated' ? 'Unallocated' :
            rawCostType === 'Shared' ? 'Shared' :
                req.body.bus ? 'Bus' :
                    req.body.route ? 'Route' :
                        (req.body.sharedAllocationMethod || req.body.sharedAllocationBasis) ? 'Shared' : 'Unallocated');

    const basisRaw = req.body.sharedAllocationMethod || req.body.sharedAllocationBasis || (allocationTargetType === 'Shared' ? 'ByKm' : 'None');
    const sharedAllocationMethod =
        basisRaw === 'PerBusEqual' ? 'EqualPerBus' :
            basisRaw === 'PerKm' ? 'ByKm' :
                basisRaw === 'PerStudent' ? 'ByStudentCount' :
                    basisRaw === 'PerRevenue' ? 'ByRevenueShare' :
                        basisRaw;

    const expense = await TransportExpense.create({
        company: companyId,
        expenseDate: expDate,
        periodKey: p.periodKey,
        category: req.body.category || 'Other',
        costClassification: req.body.costClassification ||
            (allocationTargetType === 'Shared' ? 'SharedCommon' :
                rawCostType === 'DirectFixed' || ['Insurance', 'Permit_Tax_Fitness', 'Lease_EMI', 'GPS_Technology', 'Depreciation'].includes(req.body.category)
                    ? 'DirectFixed'
                    : 'DirectVariable'),
        amount: roundMoney(req.body.amount),
        allocationTargetType,
        bus: req.body.bus || null,
        route: req.body.route || null,
        sharedAllocationMethod,
        vendor: req.body.vendor || req.body.vendorName || '',
        referenceNo: req.body.referenceNo || '',
        description: req.body.description || '',
        isNonCashDepreciation: req.body.category === 'Depreciation' || !!req.body.isNonCashDepreciation,
        createdBy: req.user?._id || null
    });

    await logAudit({
        company: companyId,
        user: req.user,
        action: 'EXPENSE_POSTED',
        entityType: 'TransportExpense',
        entityId: expense._id,
        afterState: expense.toJSON(),
        reason: req.body.description || 'Transport expense recorded'
    });

    res.status(201).json(expense.toJSON());
});

const allocateUnallocatedExpense = asyncHandler(async (req, res) => {
    const expenseId = req.params.expenseId || req.params.id;
    const expense = await TransportExpense.findById(expenseId);
    if (!expense) {
        res.status(404);
        throw new Error('Expense not found');
    }
    const beforeState = expense.toJSON();
    const rawCostType = req.body.costType || '';
    expense.allocationTargetType = req.body.allocationTargetType ||
        (rawCostType === 'Shared' ? 'Shared' : req.body.bus ? 'Bus' : 'Shared');
    expense.bus = req.body.bus || null;
    expense.route = req.body.route || null;

    const basisRaw = req.body.sharedAllocationMethod || req.body.sharedAllocationBasis || 'ByKm';
    expense.sharedAllocationMethod =
        basisRaw === 'PerBusEqual' ? 'EqualPerBus' :
            basisRaw === 'PerKm' ? 'ByKm' :
                basisRaw === 'PerStudent' ? 'ByStudentCount' :
                    basisRaw === 'PerRevenue' ? 'ByRevenueShare' :
                        basisRaw;

    await expense.save();

    await logAudit({
        company: expense.company,
        user: req.user,
        action: 'EXPENSE_ALLOCATION_UPDATED',
        entityType: 'TransportExpense',
        entityId: expense._id,
        beforeState,
        afterState: expense.toJSON(),
        reason: req.body.reason || 'Allocated previously unallocated expense'
    });

    res.json(expense.toJSON());
});

const createPayrollAllocation = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const p = parsePeriod(req.body.periodKey, req.body.month, req.body.year);

    const fixedPay = roundMoney(req.body.fixedPay || req.body.grossSalary || 0);
    const allowance = roundMoney(req.body.allowance || req.body.allowances || 0);
    const overtime = roundMoney(req.body.overtime || 0);
    const employerCost = roundMoney(req.body.employerCost || req.body.pfEsiContribution || 0);
    const deductions = roundMoney(req.body.deductions || 0);
    const totalGrossCost = addMoney(fixedPay, allowance, overtime, employerCost);
    const netPayable = Math.max(0, subMoney(totalGrossCost, deductions));

    // Process single bus or multi-bus splits
    const inputSplits = req.body.splits || req.body.allocations;
    let rawSplits = Array.isArray(inputSplits) && inputSplits.length > 0
        ? inputSplits
        : req.body.bus
            ? [{ bus: req.body.bus, route: req.body.route || null, percentage: 100 }]
            : [];

    const splits = rawSplits.map(s => {
        const pct = Number(s.percentage || s.splitPct) || (100 / rawSplits.length);
        const allocAmt = s.allocatedAmount ? roundMoney(s.allocatedAmount) : mulMoney(totalGrossCost, pct / 100);
        return {
            bus: s.bus,
            route: s.route || null,
            percentage: pct,
            allocatedAmount: allocAmt
        };
    });

    const payroll = await PayrollAllocation.create({
        company: companyId,
        staffUser: req.body.staffUser || null,
        employeeName: req.body.employeeName || req.body.staffName || 'Driver/Conductor',
        role: req.body.role || 'Driver',
        periodKey: p.periodKey,
        fixedPay,
        allowance,
        overtime,
        employerCost,
        deductions,
        totalGrossCost,
        netPayable,
        splits,
        notes: req.body.notes || '',
        createdBy: req.user?._id || null
    });

    res.status(201).json(payroll.toJSON());
});

const createFixedCostSchedule = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const totalAmount = roundMoney(req.body.totalAmount);
    const start = new Date(req.body.serviceStartDate || req.body.startDate || Date.now());
    const end = new Date(req.body.serviceEndDate || req.body.endDate || new Date(start.getFullYear() + 1, start.getMonth(), start.getDate()));
    const monthsCovered = Math.max(
        1,
        Number(req.body.monthsCovered || req.body.totalMonths) ||
            Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.4375))
    );
    const monthlyAmortizedAmount = divMoney(totalAmount, monthsCovered);

    const schedule = await FixedCostSchedule.create({
        company: companyId,
        bus: req.body.bus,
        costType: req.body.costType || 'Insurance',
        title: req.body.title || `${req.body.costType || 'Insurance'} Annual Policy`,
        totalAmount,
        principalComponent: roundMoney(req.body.principalComponent || 0),
        interestComponent: roundMoney(req.body.interestComponent || 0),
        cashPaymentDate: req.body.cashPaymentDate || req.body.paidDate || new Date(),
        serviceStartDate: start,
        serviceEndDate: end,
        monthsCovered,
        monthlyAmortizedAmount,
        isNonCashDepreciation: req.body.costType === 'Depreciation' || !!req.body.isNonCashDepreciation,
        vendor: req.body.vendor || req.body.vendorName || '',
        policyOrRefNo: req.body.policyOrRefNo || req.body.referenceNo || '',
        createdBy: req.user?._id || null
    });

    res.status(201).json(schedule.toJSON());
});

const createOdometerLog = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const d = req.body.date ? new Date(req.body.date) : new Date();
    const p = parsePeriod(req.body.periodKey, d.getMonth() + 1, d.getFullYear());
    const openingKm = Number(req.body.openingKm) || 0;
    const closingKm = Number(req.body.closingKm) || openingKm;
    const actualKm = Math.max(0, Number(req.body.actualKm) || (closingKm - openingKm));

    const log = await OdometerLog.create({
        company: companyId,
        bus: req.body.bus,
        route: req.body.route || null,
        date: d,
        periodKey: p.periodKey,
        openingKm,
        closingKm,
        actualKm,
        plannedKm: Number(req.body.plannedKm) || 0,
        source: req.body.source || 'Manual',
        notes: req.body.notes || '',
        createdBy: req.user?._id || null
    });

    if (closingKm > 0) {
        await Vehicle.findByIdAndUpdate(req.body.bus, { lastOdometer: closingKm });
    }

    res.status(201).json(log);
});

// 16. Geocoding, Route Search, Financially Aware Recommendations & Simulation
const geocodeEndpoint = asyncHandler(async (req, res) => {
    const { address, lat, lng } = req.body;
    if (lat !== undefined && lng !== undefined && !address) {
        return res.json({
            originalAddress: `${lat}, ${lng}`,
            normalizedAddress: `Pinned Location (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)})`,
            lat: Number(lat),
            lng: Number(lng),
            provider: 'ManualPin',
            geocodeStatus: 'ManualPin'
        });
    }
    const result = await geocodeAddress(address);
    res.json(result);
});

const autocompleteEndpoint = asyncHandler(async (req, res) => {
    const suggestions = await autocompleteAddress(req.query.q || '');
    res.json(suggestions);
});

const routeSearchAndRecommend = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const result = await evaluateRouteRecommendations({
        companyId,
        studentId: req.body.studentId,
        studentName: req.body.studentName,
        address: req.body.address,
        lat: req.body.lat,
        lng: req.body.lng,
        shift: req.body.shift || 'Both',
        direction: req.body.direction || 'Two-Way',
        searchRadiusKm: req.body.searchRadiusKm || 8,
        feePlanId: req.body.feePlanId,
        customMonthlyFee: req.body.customMonthlyFee !== undefined ? req.body.customMonthlyFee : req.body.expectedMonthlyFee,
        saveRun: req.body.saveRun !== false,
        user: req.user
    });
    res.json(result);
});

const simulateRouteInsertion = asyncHandler(async (req, res) => {
    const routeId = req.params.routeId || req.body.routeId;
    const { lat, lng, address, expectedMonthlyFee, monthlyFee } = req.body;
    const route = await Route.findById(routeId).populate('assignedBus').lean();
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }
    const companyId = route.company || resolveCompanyId(req);

    const company = await Company.findById(companyId).lean();
    const schoolPoint = {
        lat: Number(company?.schoolLat) || 26.9124,
        lng: Number(company?.schoolLng) || 75.7873
    };

    let targetLat = lat !== undefined && lat !== null ? Number(lat) : null;
    let targetLng = lng !== undefined && lng !== null ? Number(lng) : null;
    if ((targetLat === null || targetLng === null) && address) {
        const geo = await geocodeAddress(address, schoolPoint);
        targetLat = geo.lat;
        targetLng = geo.lng;
    }

    const detour = calculateInsertionDetour(route, targetLat, targetLng, schoolPoint);
    const profitability = await calculateTransportProfitability(companyId, {});
    const routeFin = profitability.routeSummary.find(r => String(r.routeId) === String(route._id));

    const operatingDays = Number(company?.operatingDaysPerMonth) || 22;
    const varCostPerKm = routeFin && routeFin.costPerKm > 0 ? Math.min(30, routeFin.costPerKm) : 18;
    const fee = roundMoney(expectedMonthlyFee || monthlyFee || route.defaultFeeAmount || routeFin?.revenuePerStudent || 2200);
    const incMonthlyKm = Number((detour.detourRoundTripKm * operatingDays).toFixed(2));
    const incMonthlyCost = mulMoney(varCostPerKm, incMonthlyKm);
    const incContribution = subMoney(fee, incMonthlyCost);

    res.json({
        routeId: route._id,
        routeName: route.name,
        busCode: routeFin?.busDisplayCode || route.assignedBus?.carNumber,
        detour,
        detourKm: detour.detourRoundTripKm,
        detourMinutes: detour.detourMinutes,
        insertAfterStopName: detour.insertAfterStopName || 'Start',
        incrementalMonthlyCost: incMonthlyCost,
        netIncrementalContribution: incContribution,
        isFeasible: detour.detourMinutes <= 20 && (routeFin?.availableSeats ?? 1) > 0,
        before: {
            plannedDailyKm: routeFin?.plannedDailyKm || route.plannedKm || 28,
            plannedMinutes: routeFin?.plannedMinutes || route.plannedMinutes || 45,
            occupiedSeats: routeFin?.occupiedSeats || 0,
            availableSeats: routeFin?.availableSeats || 0,
            monthlyRevenue: routeFin?.periodRevenue || 0,
            monthlyCost: routeFin?.totalOperatingCost || 0,
            operatingContribution: routeFin?.operatingContribution || 0
        },
        after: {
            plannedDailyKm: Number(((routeFin?.plannedDailyKm || route.plannedKm || 28) + detour.detourRoundTripKm).toFixed(2)),
            plannedMinutes: (routeFin?.plannedMinutes || route.plannedMinutes || 45) + detour.detourMinutes,
            occupiedSeats: (routeFin?.occupiedSeats || 0) + 1,
            availableSeats: Math.max(0, (routeFin?.availableSeats || 0) - 1),
            monthlyRevenue: addMoney(routeFin?.periodRevenue || 0, fee),
            monthlyCost: addMoney(routeFin?.totalOperatingCost || 0, incMonthlyCost),
            operatingContribution: addMoney(routeFin?.operatingContribution || 0, incContribution),
            incrementalMonthlyRevenue: fee,
            incrementalMonthlyCost: incMonthlyCost,
            incrementalMonthlyContribution: incContribution
        }
    });
});

// 17. GET /api/transport/reports/transport-profitability (and GET /api/transport/:companyId/profitability)
const getProfitabilityReport = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const period = req.query.period || req.query.periodKey;
    const { month, year, includeDepreciation = 'true' } = req.query;
    const current = await calculateTransportProfitability(companyId, {
        period,
        month,
        year,
        includeDepreciation: includeDepreciation !== 'false'
    });

    // Also compute prior month for trend comparison
    const p = parsePeriod(period, month, year);
    const prevMonth = p.monthNum === 1 ? 12 : p.monthNum - 1;
    const prevYear = p.monthNum === 1 ? p.year - 1 : p.year;
    const prior = await calculateTransportProfitability(companyId, {
        month: prevMonth,
        year: prevYear,
        includeDepreciation: includeDepreciation !== 'false'
    });

    res.json({
        ...current,
        priorPeriodSummary: {
            periodKey: prior.periodKey,
            month: prior.month,
            year: prior.year,
            billedTransportRevenue: prior.schoolSummary.billedTransportRevenue,
            cashCollected: prior.schoolSummary.cashCollected,
            totalOperatingCost: prior.schoolSummary.totalOperatingCost,
            operatingContribution: prior.schoolSummary.operatingContribution,
            contributionMarginPercent: prior.schoolSummary.contributionMarginPercent
        }
    });
});

// 18. Settings, Onboarding Baseline Validator (Section 11) & Audit Logs
const getTransportSettingsAndValidation = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    await ensureBaselineAssignments(companyId);

    const [company, fleetSnapshot, routes, students, subscriptions, unallocatedExpenses] = await Promise.all([
        Company.findById(companyId).lean(),
        getFleetCapacitySnapshot(companyId, {}),
        Route.find({ company: companyId }).lean(),
        Student.find({ company: companyId, status: { $ne: 'inactive' } }).lean(),
        StudentFeeSubscription.find({ company: companyId, status: 'Active', effectiveTo: null }).lean(),
        TransportExpense.find({ company: companyId, allocationTargetType: 'Unallocated', status: 'Posted' }).lean()
    ]);

    const subStudentIds = new Set(subscriptions.map(s => String(s.student)));
    const missingCoordinatesStudents = students.filter(s => s.assignedBus && (!s.pickupLat || !s.pickupLng));
    const missingFeeSubscriptionStudents = students.filter(s => s.assignedBus && !subStudentIds.has(String(s._id)));
    const overCapacityBuses = fleetSnapshot.buses.filter(b => b.capacity.isOverCapacity);
    const routesWithoutStops = routes.filter(r => !r.stops || r.stops.length === 0);
    const routesWithoutBus = routes.filter(r => !r.assignedBus);

    const validationChecks = [
        {
            code: 'BUS_CAPACITY_BASELINE',
            name: 'Bus Master & Seating Capacities',
            label: 'Bus Master & Seating Capacities',
            passed: fleetSnapshot.buses.length > 0 && overCapacityBuses.length === 0,
            issueCount: overCapacityBuses.length,
            detail: overCapacityBuses.length > 0
                ? `${overCapacityBuses.length} bus(es) exceed usable capacity`
                : `${fleetSnapshot.buses.length} active bus(es) verified within usable capacity`
        },
        {
            code: 'ROUTE_STOPS_GEOMETRY',
            name: 'Routes & Ordered Stops Geometry',
            label: 'Routes & Ordered Stops Geometry',
            passed: routes.length > 0 && routesWithoutStops.length === 0 && routesWithoutBus.length === 0,
            issueCount: routesWithoutStops.length + routesWithoutBus.length,
            detail: `${routes.length} routes configured (${routesWithoutStops.length} missing stops, ${routesWithoutBus.length} missing bus)`
        },
        {
            code: 'STUDENT_GEOCODES',
            name: 'Student Pickup Coordinates',
            label: 'Student Pickup Coordinates',
            passed: missingCoordinatesStudents.length === 0,
            issueCount: missingCoordinatesStudents.length,
            detail: missingCoordinatesStudents.length > 0
                ? `${missingCoordinatesStudents.length} transport student(s) missing lat/lng coordinates`
                : `All active transport students have map coordinates`
        },
        {
            code: 'STUDENT_FEE_SUBSCRIPTIONS',
            name: 'Student Transport Fee Subscriptions',
            label: 'Student Transport Fee Subscriptions',
            passed: missingFeeSubscriptionStudents.length === 0,
            issueCount: missingFeeSubscriptionStudents.length,
            detail: missingFeeSubscriptionStudents.length > 0
                ? `${missingFeeSubscriptionStudents.length} student(s) missing active fee subscription`
                : `All assigned students linked to effective-dated fee subscriptions`
        },
        {
            code: 'FEE_PLAN_MASTER',
            name: 'Fee Plan & Baseline Readiness',
            label: 'Fee Plan & Baseline Readiness',
            passed: subscriptions.length > 0,
            issueCount: 0,
            detail: `${subscriptions.length} active subscriptions verified (${unallocatedExpenses.length} unallocated expenses in review queue)`
        }
    ];

    const passedCount = validationChecks.filter(c => c.passed).length;

    res.json({
        company,
        checks: validationChecks,
        validationChecks,
        issues: validationChecks.filter(c => !c.passed).map(c => c.detail),
        passedCount,
        totalChecks: validationChecks.length,
        allPassed: validationChecks.every(c => c.passed)
    });
});

const updateTransportSettings = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const company = await Company.findById(companyId);
    if (!company) {
        res.status(404);
        throw new Error('Company/School not found');
    }

    const beforeState = {
        optimizerWeights: company.optimizerWeights,
        alertThresholds: company.alertThresholds,
        operatingDaysPerMonth: company.operatingDaysPerMonth,
        defaultVariableCostPerKm: company.defaultVariableCostPerKm
    };

    if (req.body.address !== undefined) company.address = req.body.address;
    if (req.body.schoolLat !== undefined) company.schoolLat = Number(req.body.schoolLat);
    if (req.body.schoolLng !== undefined) company.schoolLng = Number(req.body.schoolLng);
    if (req.body.academicYear !== undefined) company.academicYear = req.body.academicYear;
    if (req.body.operatingDaysPerMonth !== undefined) company.operatingDaysPerMonth = Number(req.body.operatingDaysPerMonth);
    if (req.body.defaultVariableCostPerKm !== undefined) company.defaultVariableCostPerKm = Number(req.body.defaultVariableCostPerKm);
    if (req.body.optimizerWeights) {
        const w = req.body.optimizerWeights;
        company.optimizerWeights = {
            ...company.optimizerWeights,
            ...w,
            proximity: w.proximity !== undefined ? Number(w.proximity) : company.optimizerWeights?.proximity,
            detour: w.detour !== undefined ? Number(w.detour) : company.optimizerWeights?.detour,
            seatAvailability: (w.seatAvailability ?? w.seats) !== undefined ? Number(w.seatAvailability ?? w.seats) : company.optimizerWeights?.seatAvailability,
            routeProfitability: (w.routeProfitability ?? w.profitability) !== undefined ? Number(w.routeProfitability ?? w.profitability) : company.optimizerWeights?.routeProfitability,
            serviceWindow: (w.serviceWindow ?? w.timeFit) !== undefined ? Number(w.serviceWindow ?? w.timeFit) : company.optimizerWeights?.serviceWindow
        };
    }
    if (req.body.alertThresholds) company.alertThresholds = { ...company.alertThresholds, ...req.body.alertThresholds };
    if (req.body.baselineConfirmed !== undefined) {
        company.baselineConfirmed = !!req.body.baselineConfirmed;
        if (company.baselineConfirmed) company.baselineConfirmedAt = new Date();
    }

    await company.save();

    await logAudit({
        company: companyId,
        user: req.user,
        action: 'TRANSPORT_SETTINGS_UPDATED',
        entityType: 'Company',
        entityId: company._id,
        beforeState,
        afterState: {
            optimizerWeights: company.optimizerWeights,
            alertThresholds: company.alertThresholds,
            baselineConfirmed: company.baselineConfirmed
        },
        reason: req.body.reason || 'Updated school transport settings'
    });

    res.json(company);
});

const getAuditLogsAndOptimizationHistory = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const [auditLogs, optimizationRuns] = await Promise.all([
        AuditLog.find({ company: companyId }).sort({ createdAt: -1 }).limit(100).lean(),
        OptimizationRun.find({ company: companyId })
            .populate('selectedBus', 'carNumber displayCode')
            .populate('selectedRoute', 'name code')
            .sort({ createdAt: -1 })
            .limit(50)
    ]);

    res.json({
        auditLogs,
        optimizationRuns: optimizationRuns.map(r => r.toJSON())
    });
});

const getAuditLogsOnly = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const limit = Number(req.query.limit) || 100;
    const logs = await AuditLog.find({ company: companyId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    res.json(logs.map(l => ({
        ...l,
        actorName: l.actorName || 'Admin'
    })));
});

const getOptimizationRunsOnly = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const runs = await OptimizationRun.find({ company: companyId })
        .populate('selectedBus', 'carNumber displayCode')
        .populate('selectedRoute', 'name code')
        .sort({ createdAt: -1 })
        .limit(50);

    res.json(runs.map(r => {
        const json = r.toJSON();
        const top = (json.recommendations || [])[0] || {};
        return {
            ...json,
            recommendedBus: json.selectedBus
                ? { ...json.selectedBus, busNumber: json.selectedBus.displayCode || json.selectedBus.carNumber }
                : top.busDisplayCode ? { busNumber: top.busDisplayCode } : null,
            recommendedRoute: json.selectedRoute
                ? { ...json.selectedRoute, routeName: json.selectedRoute.name }
                : top.routeName ? { routeName: top.routeName } : null,
            topScore: top.compositeScore || 0,
            incrementalMargin: top.incrementalMonthlyContribution || 0,
            confirmed: json.decisionStatus === 'Confirmed'
        };
    }));
});

// 19. Standard 10-Report Suite + CSV Export
const getStandardTransportReport = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const reportType = req.params.reportType || req.query.reportType || 'bus_pnl';
    const period = req.query.period || req.query.periodKey;
    const { month, year, format } = req.query;

    const profitability = await calculateTransportProfitability(companyId, { period, month, year });
    let rows = [];

    if (reportType === 'school_summary') {
        rows = [{
            Period: profitability.periodKey,
            BilledRevenue: profitability.schoolSummary.billedTransportRevenue,
            EffectivePeriodRevenue: profitability.schoolSummary.effectivePeriodRevenue,
            CashCollected: profitability.schoolSummary.cashCollected,
            OutstandingReceivables: profitability.schoolSummary.outstandingReceivables,
            TotalOperatingCost: profitability.schoolSummary.totalOperatingCost,
            OperatingContribution: profitability.schoolSummary.operatingContribution,
            MarginPercent: `${profitability.schoolSummary.contributionMarginPercent}%`,
            TotalSeats: profitability.schoolSummary.totalSeats,
            UsableSeats: profitability.schoolSummary.usableSeats,
            OccupiedSeats: profitability.schoolSummary.occupiedSeats,
            AvailableSeats: profitability.schoolSummary.availableSeats,
            OccupancyPercent: `${profitability.schoolSummary.fleetOccupancyPercent}%`
        }];
    } else if (reportType === 'bus_pnl') {
        rows = profitability.busSummary.map(b => ({
            BusCode: b.displayCode || b.carNumber,
            Registration: b.carNumber,
            Route: b.routeName || 'Unassigned',
            OccupiedSeats: `${b.capacity.occupiedSeats}/${b.capacity.usableCapacity}`,
            OccupancyPct: `${b.capacity.occupancyPercent}%`,
            BilledRevenue: b.billedRevenue,
            CashCollected: b.cashCollected,
            CrewPayroll: b.directStaffCost,
            FuelCost: b.fuelCost,
            MaintAndFixed: addMoney(b.maintenanceCost || 0, b.fixedVehicleCost || 0, b.allocatedSharedCost || 0),
            TotalCost: b.totalOperatingCost,
            Contribution: b.operatingContribution,
            MarginPct: `${b.contributionMarginPercent}%`,
            BreakEvenStudents: b.breakEvenStudents,
            CostPerKm: b.costPerKm
        }));
    } else if (reportType === 'route_pnl') {
        rows = profitability.routeSummary.map(r => ({
            RouteName: r.routeName,
            RouteCode: r.routeCode,
            AssignedBus: r.busDisplayCode || 'Unassigned',
            Students: r.occupiedSeats,
            Stops: r.stopsCount,
            MonthlyKm: r.actualPeriodKm || r.plannedMonthlyKm || 0,
            PeriodRevenue: r.periodRevenue,
            TotalCost: r.totalOperatingCost,
            Contribution: r.operatingContribution,
            MarginPct: `${r.contributionMarginPercent}%`
        }));
    } else if (reportType === 'seat_utilization') {
        rows = profitability.busSummary.map(b => ({
            BusCode: b.displayCode || b.carNumber,
            Route: b.routeName || 'Unassigned',
            TotalSeats: b.capacity.totalSeats,
            ReservedSeats: b.capacity.reservedSeats || 0,
            UsableCapacity: b.capacity.usableCapacity,
            OccupiedSeats: b.capacity.occupiedSeats,
            AvailableSeats: b.capacity.availableSeats,
            OccupancyPct: `${b.capacity.occupancyPercent}%`,
            Status: b.overallHealth
        }));
    } else if (reportType === 'student_billing') {
        const p = parsePeriod(period, month, year);
        const demands = await TransportDemand.find({ company: companyId, periodKey: p.periodKey })
            .populate('student', 'name className batch rollNumber')
            .populate('attributedBus', 'carNumber displayCode')
            .lean();
        rows = demands.map(d => ({
            DemandNo: d.demandNo,
            Student: d.student?.name || 'Student',
            Class: d.student?.className || '',
            Bus: d.attributedBus?.displayCode || d.attributedBus?.carNumber || 'N/A',
            Period: d.periodKey,
            NetBilled: d.netAmount,
            PaidAmount: d.allocatedAmount || 0,
            BalanceDue: d.outstandingAmount || 0,
            Status: d.status
        }));
    } else if (reportType === 'collection_register') {
        const receipts = await TransportReceipt.find({ company: companyId, status: { $ne: 'Reversed' } })
            .populate('student', 'name className')
            .sort({ receiptDate: -1 })
            .limit(100)
            .lean();
        rows = receipts.map(r => ({
            ReceiptNo: r.receiptNo,
            Date: r.receiptDate ? new Date(r.receiptDate).toISOString().slice(0, 10) : '',
            Student: r.student?.name || 'Student',
            Class: r.student?.className || '',
            Mode: r.paymentMode,
            AmountReceived: r.amount,
            AllocatedToDues: r.allocatedAmount || 0,
            AdvanceCredit: r.unallocatedAdvanceAmount || 0
        }));
    } else if (reportType === 'overdue_aging') {
        const col = await getCollectionsOverview(companyId, { period, month, year });
        rows = (col.openDemands || []).map(d => ({
            DemandNo: d.demandNo,
            Student: d.student?.name || 'Student',
            Class: d.student?.className || '',
            Period: d.periodKey,
            DueDate: d.dueDate ? new Date(d.dueDate).toISOString().slice(0, 10) : '',
            NetBilled: d.netAmount,
            BalanceOverdue: d.outstandingAmount,
            DaysOverdue: d.daysOverdue || 0,
            Bucket: d.agingBucket || 'Current'
        }));
    } else if (reportType === 'fuel_efficiency') {
        rows = profitability.busSummary.map(b => ({
            BusCode: b.displayCode || b.carNumber,
            Route: b.routeName || 'Unassigned',
            MonthlyKm: b.actualPeriodKm || b.plannedMonthlyKm || 0,
            FuelCost: b.fuelCost,
            TotalOperatingCost: b.totalOperatingCost,
            CostPerKm: b.costPerKm
        }));
    } else if (reportType === 'maintenance_cost') {
        rows = profitability.busSummary.map(b => ({
            BusCode: b.displayCode || b.carNumber,
            MaintenanceCost: b.maintenanceCost,
            FixedComplianceCost: b.fixedVehicleCost,
            SharedAllocatedCost: b.allocatedSharedCost,
            TotalNonFuelNonStaff: addMoney(b.maintenanceCost || 0, b.fixedVehicleCost || 0, b.allocatedSharedCost || 0)
        }));
    } else if (reportType === 'recommendation_log') {
        const runs = await OptimizationRun.find({ company: companyId })
            .populate('selectedBus', 'carNumber displayCode')
            .populate('selectedRoute', 'name code')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        rows = runs.map(r => {
            const top = (r.recommendations || [])[0] || {};
            return {
                Date: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '',
                Student: r.studentName || 'Inquiry',
                Address: r.inputAddress || '',
                TopBus: top.busDisplayCode || r.selectedBus?.carNumber || 'N/A',
                TopRoute: top.routeName || r.selectedRoute?.name || 'N/A',
                CompositeScore: top.compositeScore || 0,
                IncMonthlyMargin: top.incrementalMonthlyContribution || 0,
                DecisionStatus: r.decisionStatus || 'Evaluated'
            };
        });
    }

    if (format === 'csv') {
        const cols = rows.length > 0 ? Object.keys(rows[0]) : ['Empty'];
        const csvLines = [
            cols.join(','),
            ...rows.map(row => cols.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(','))
        ];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="transport_${reportType}_${profitability.periodKey}.csv"`);
        return res.send(csvLines.join('\n'));
    }

    res.json({ reportType, periodKey: profitability.periodKey, rows });
});

// 20. Period Locks & Baseline Sync Endpoints
const getPeriodLocks = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const logs = await AuditLog.find({
        company: companyId,
        action: { $in: ['PERIOD_LOCKED', 'PERIOD_UNLOCKED'] }
    })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

    const byPeriod = new Map();
    for (const log of logs) {
        const pk = log.afterState?.periodKey || log.reason?.match(/\d{4}-\d{2}/)?.[0] || '2026-10';
        if (!byPeriod.has(pk)) {
            byPeriod.set(pk, {
                _id: log._id,
                periodKey: pk,
                isLocked: log.action === 'PERIOD_LOCKED',
                notes: log.reason,
                updatedAt: log.createdAt
            });
        }
    }
    res.json(Array.from(byPeriod.values()));
});

const togglePeriodLock = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    const action = req.params.action === 'unlock' ? 'unlock' : 'lock';
    const { periodKey = '2026-10', notes } = req.body;

    const entry = await logAudit({
        company: companyId,
        user: req.user,
        action: action === 'lock' ? 'PERIOD_LOCKED' : 'PERIOD_UNLOCKED',
        entityType: 'FinancialPeriod',
        entityId: companyId,
        afterState: { periodKey, isLocked: action === 'lock' },
        reason: notes || `Period ${periodKey} ${action}ed`
    });

    res.json({
        _id: entry?._id || Date.now(),
        periodKey,
        isLocked: action === 'lock',
        notes: notes || `Period ${periodKey} ${action}ed`,
        updatedAt: new Date()
    });
});

const syncBaselineStructure = asyncHandler(async (req, res) => {
    const companyId = resolveCompanyId(req);
    await ensureBaselineAssignments(companyId);

    const [buses, routes, subscriptions] = await Promise.all([
        Vehicle.countDocuments({ company: companyId, carType: { $in: ['Bus', 'Mini Bus'] } }),
        Route.countDocuments({ company: companyId }),
        StudentFeeSubscription.countDocuments({ company: companyId, status: 'Active', effectiveTo: null })
    ]);

    res.json({
        message: 'Baseline structure synchronized',
        busesSynced: buses,
        routesSynced: routes,
        subscriptionsSynced: subscriptions
    });
});

module.exports = {
    getTransportDashboard,
    getSchoolFleet,
    getSchoolFleetArray,
    getBusDetail,
    getBusFinancials,
    getRouteDetail,
    getRouteFinancials,
    getFeePlans,
    createFeePlan,
    updateFeePlan,
    createStudentSubscriptionAndAssignment,
    getSubscriptions,
    getAssignments,
    updateStudentTransportStatus,
    generateBilling,
    getDemands,
    adjustDemand,
    postOpeningBalance,
    getCollections,
    getReceipts,
    createReceipt,
    allocateReceipt,
    createRefund,
    getStudentLedger,
    getExpensesAndCosts,
    getExpensesOnly,
    getPayrollOnly,
    getFixedSchedulesOnly,
    createExpense,
    allocateUnallocatedExpense,
    createPayrollAllocation,
    createFixedCostSchedule,
    createOdometerLog,
    geocodeEndpoint,
    autocompleteEndpoint,
    routeSearchAndRecommend,
    simulateRouteInsertion,
    getProfitabilityReport,
    getTransportSettingsAndValidation,
    updateTransportSettings,
    getAuditLogsAndOptimizationHistory,
    getAuditLogsOnly,
    getOptimizationRunsOnly,
    getStandardTransportReport,
    getPeriodLocks,
    togglePeriodLock,
    syncBaselineStructure
};

