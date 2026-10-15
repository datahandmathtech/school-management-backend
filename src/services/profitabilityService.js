const Company = require('../models/Company');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const Student = require('../models/Student');
const TransportDemand = require('../models/TransportDemand');
const TransportReceipt = require('../models/TransportReceipt');
const StudentFeeSubscription = require('../models/StudentFeeSubscription');
const TransportExpense = require('../models/TransportExpense');
const PayrollAllocation = require('../models/PayrollAllocation');
const FixedCostSchedule = require('../models/FixedCostSchedule');
const OdometerLog = require('../models/OdometerLog');
const Fuel = require('../models/Fuel');
const Maintenance = require('../models/Maintenance');
const {
    roundMoney,
    addMoney,
    subMoney,
    mulMoney,
    divMoney,
    parsePeriod
} = require('../utils/moneyUtils');
const { getFleetCapacitySnapshot } = require('./capacityService');

/**
 * Compute comprehensive Bus, Route, and School Profitability + Alerts for a given period
 */
const calculateTransportProfitability = async (companyId, { period, month, year, includeDepreciation = true } = {}) => {
    const p = parsePeriod(period, month, year);
    const company = await Company.findById(companyId).lean();
    const operatingDaysDefault = Number(company?.operatingDaysPerMonth) || 22;
    const minOccupancyThreshold = Number(company?.alertThresholds?.minOccupancyPercent) || 60;
    const nearlyFullThreshold = Number(company?.alertThresholds?.nearlyFullPercent) || 90;
    const mileageDeviationThreshold = Number(company?.alertThresholds?.mileageDeviationPercent) || 20;
    const overdueThreshold = Number(company?.alertThresholds?.overdueAmountThreshold) || 5000;

    // 1. Get capacity snapshot as of period end
    const fleetSnapshot = await getFleetCapacitySnapshot(companyId, {
        asOfDate: p.endDate,
        nearlyFullThreshold
    });

    const buses = fleetSnapshot.buses;
    const busIds = buses.map(b => b._id);

    // 2. Fetch all financial & operational records for the period in parallel
    const [
        routes,
        periodDemands,
        allOpenDemands,
        periodReceipts,
        activeSubscriptions,
        fuelLogs,
        maintenanceJobs,
        payrollAllocations,
        fixedSchedules,
        transportExpenses,
        odometerLogs,
        allStudents
    ] = await Promise.all([
        Route.find({ company: companyId }).populate('assignedBus', 'carNumber displayCode seatingCapacity reservedSeats').lean(),
        TransportDemand.find({
            company: companyId,
            periodKey: p.periodKey,
            status: { $nin: ['Cancelled', 'Reversed'] }
        }).lean(),
        TransportDemand.find({
            company: companyId,
            status: { $in: ['Pending', 'Partial'] },
            outstandingAmount: { $gt: 0 }
        }).lean(),
        TransportReceipt.find({
            company: companyId,
            periodKey: p.periodKey,
            status: { $ne: 'Reversed' }
        }).lean(),
        StudentFeeSubscription.find({
            company: companyId,
            status: 'Active',
            effectiveFrom: { $lte: p.endDate },
            $or: [{ effectiveTo: null }, { effectiveTo: { $gte: p.startDate } }]
        }).lean(),
        Fuel.find({
            company: companyId,
            date: { $gte: p.startDate, $lte: p.endDate }
        }).lean(),
        Maintenance.find({
            company: companyId,
            billDate: { $gte: p.startDate, $lte: p.endDate }
        }).lean(),
        PayrollAllocation.find({
            company: companyId,
            periodKey: p.periodKey,
            paymentStatus: { $ne: 'Cancelled' }
        }).lean(),
        FixedCostSchedule.find({
            company: companyId,
            status: 'Active',
            serviceStartDate: { $lte: p.endDate },
            serviceEndDate: { $gte: p.startDate }
        }).lean(),
        TransportExpense.find({
            company: companyId,
            periodKey: p.periodKey,
            status: 'Posted'
        }).lean(),
        OdometerLog.find({
            company: companyId,
            periodKey: p.periodKey
        }).lean(),
        Student.find({
            company: companyId,
            status: { $ne: 'inactive' }
        }).lean()
    ]);

    // Map student -> current/period bus & route
    const studentBusMap = {};
    const studentRouteMap = {};
    buses.forEach(b => {
        (b.activeAssignments || []).forEach(a => {
            const sId = String(a.student?._id || a.student);
            studentBusMap[sId] = String(b._id);
            if (a.route) studentRouteMap[sId] = String(a.route?._id || a.route);
            else if (b.activeRoute) studentRouteMap[sId] = String(b.activeRoute?._id || b.activeRoute);
        });
    });

    // Build per-bus accumulator
    const busMetricsMap = {};
    buses.forEach(bus => {
        const bId = String(bus._id);
        const linkedRoute = bus.activeRoute;
        const plannedDailyKm = Number(linkedRoute?.plannedKm) || 28;
        const opDays = Number(linkedRoute?.operatingDaysPerMonth) || operatingDaysDefault;
        const plannedPeriodKm = roundMoney(plannedDailyKm * opDays);

        busMetricsMap[bId] = {
            busId: bus._id,
            displayCode: bus.displayCode,
            carNumber: bus.carNumber,
            model: bus.model,
            busType: bus.busType,
            driverName: bus.currentDriver?.name || 'Unassigned',
            conductorName: bus.assignedConductor?.name || null,
            routeId: linkedRoute?._id || null,
            routeName: linkedRoute?.name || 'Unassigned Route',
            routeCode: linkedRoute?.code || null,
            capacity: bus.capacity,
            plannedPeriodKm,
            actualPeriodKm: 0,
            effectivePeriodKm: plannedPeriodKm,
            kmSource: 'PlannedRouteKm',
            fuelQuantity: 0,
            avgMileage: 0,
            // Revenue & Receivables
            billedRevenue: 0,
            accruedSubscriptionRevenue: 0,
            periodRevenue: 0,
            revenueSource: 'PostedDemands',
            cashCollected: 0,
            totalOutstanding: 0,
            // Cost Breakdown
            fuelCost: 0,
            tollFastagCost: 0,
            otherVariableCost: 0,
            directVariableCost: 0,
            directStaffCost: 0,
            maintenanceCost: 0,
            capitalMaintenanceCost: 0,
            fixedVehicleCost: 0,
            depreciationCost: 0,
            sharedOverheadCost: 0,
            totalOperatingCost: 0,
            // Derived
            operatingContribution: 0,
            contributionMarginPercent: 0,
            costPerKm: 0,
            revenuePerKm: 0,
            costPerStudent: 0,
            revenuePerStudent: 0,
            avgMonthlyFeePerStudent: 0,
            breakEvenStudents: 0,
            breakEvenOccupancyPercent: 0,
            statusFlags: [],
            overallHealth: 'Healthy'
        };
    });

    // 3. Attribute Billed Demands & Subscriptions to Buses
    const hasPostedDemands = periodDemands.length > 0;
    periodDemands.forEach(d => {
        const sId = String(d.student);
        const bId = String(d.attributedBus || studentBusMap[sId] || '');
        if (busMetricsMap[bId]) {
            busMetricsMap[bId].billedRevenue = addMoney(busMetricsMap[bId].billedRevenue, roundMoney(d.netAmount));
        }
    });

    activeSubscriptions.forEach(sub => {
        const sId = String(sub.student);
        const bId = String(sub.bus || studentBusMap[sId] || '');
        if (busMetricsMap[bId]) {
            busMetricsMap[bId].accruedSubscriptionRevenue = addMoney(
                busMetricsMap[bId].accruedSubscriptionRevenue,
                roundMoney(sub.monthlyEquivalentAmount || sub.netPeriodicAmount)
            );
        }
    });

    // Attribute Open Receivables
    allOpenDemands.forEach(d => {
        const sId = String(d.student);
        const bId = String(d.attributedBus || studentBusMap[sId] || '');
        if (busMetricsMap[bId]) {
            busMetricsMap[bId].totalOutstanding = addMoney(busMetricsMap[bId].totalOutstanding, roundMoney(d.outstandingAmount));
        }
    });

    // Attribute Period Receipts (Cash Collected)
    periodReceipts.forEach(r => {
        const sId = String(r.student);
        const bId = studentBusMap[sId] || '';
        const netRcpt = subMoney(roundMoney(r.amount), roundMoney(r.refundedAmount || 0));
        if (busMetricsMap[bId]) {
            busMetricsMap[bId].cashCollected = addMoney(busMetricsMap[bId].cashCollected, netRcpt);
        }
    });

    // 4. Attribute Fuel Logs & Odometer KM
    const syncedFuelIds = new Set();
    fuelLogs.forEach(f => {
        const bId = String(f.vehicle);
        syncedFuelIds.add(String(f._id));
        if (busMetricsMap[bId]) {
            busMetricsMap[bId].fuelCost = addMoney(busMetricsMap[bId].fuelCost, roundMoney(f.amount));
            busMetricsMap[bId].fuelQuantity = Number((busMetricsMap[bId].fuelQuantity + (Number(f.quantity) || 0)).toFixed(2));
            if (Number(f.distance) > 0) {
                busMetricsMap[bId].actualPeriodKm += Number(f.distance);
            }
        }
    });

    odometerLogs.forEach(o => {
        const bId = String(o.bus);
        if (busMetricsMap[bId] && Number(o.actualKm) > 0) {
            busMetricsMap[bId].actualPeriodKm += Number(o.actualKm);
        }
    });

    // 5. Attribute Maintenance Jobs
    const syncedMaintIds = new Set();
    maintenanceJobs.forEach(m => {
        const bId = String(m.vehicle);
        syncedMaintIds.add(String(m._id));
        if (busMetricsMap[bId]) {
            if (m.isCapitalReplacement) {
                busMetricsMap[bId].capitalMaintenanceCost = addMoney(busMetricsMap[bId].capitalMaintenanceCost, roundMoney(m.amount));
            } else {
                busMetricsMap[bId].maintenanceCost = addMoney(busMetricsMap[bId].maintenanceCost, roundMoney(m.amount));
            }
        }
    });

    // 6. Attribute Payroll Allocations
    const busesWithExplicitPayroll = new Set();
    payrollAllocations.forEach(pa => {
        (pa.splits || []).forEach(split => {
            const bId = String(split.bus);
            if (busMetricsMap[bId]) {
                busesWithExplicitPayroll.add(bId);
                busMetricsMap[bId].directStaffCost = addMoney(busMetricsMap[bId].directStaffCost, roundMoney(split.allocatedAmount));
            }
        });
    });

    // Fallback to assigned driver/conductor salary if no explicit PayrollAllocation posted for that bus
    buses.forEach(bus => {
        const bId = String(bus._id);
        if (!busesWithExplicitPayroll.has(bId) && busMetricsMap[bId]) {
            const driverSalary = roundMoney(bus.currentDriver?.salary || 0);
            const conductorSalary = roundMoney(bus.assignedConductor?.salary || 0);
            const combined = addMoney(driverSalary, conductorSalary);
            if (combined > 0) {
                busMetricsMap[bId].directStaffCost = addMoney(busMetricsMap[bId].directStaffCost, combined);
            }
        }
    });

    // 7. Attribute Fixed Cost Schedules (Monthly Amortization)
    fixedSchedules.forEach(fc => {
        const bId = String(fc.bus);
        if (busMetricsMap[bId]) {
            const monthlyAmt = roundMoney(fc.monthlyAmortizedAmount);
            if (fc.costType === 'Depreciation' || fc.isNonCashDepreciation) {
                busMetricsMap[bId].depreciationCost = addMoney(busMetricsMap[bId].depreciationCost, monthlyAmt);
                if (includeDepreciation) {
                    busMetricsMap[bId].fixedVehicleCost = addMoney(busMetricsMap[bId].fixedVehicleCost, monthlyAmt);
                }
            } else {
                busMetricsMap[bId].fixedVehicleCost = addMoney(busMetricsMap[bId].fixedVehicleCost, monthlyAmt);
            }
        }
    });

    // 8. Process TransportExpense entries (Direct, Shared & Unallocated)
    const sharedExpenses = [];
    const unallocatedExpenses = [];

    transportExpenses.forEach(exp => {
        if (exp.sourceModel === 'Fuel' && exp.sourceId && syncedFuelIds.has(String(exp.sourceId))) return;
        if (exp.sourceModel === 'Maintenance' && exp.sourceId && syncedMaintIds.has(String(exp.sourceId))) return;

        const amt = roundMoney(exp.amount);
        if (exp.allocationTargetType === 'Unallocated' || (!exp.bus && !exp.route && exp.allocationTargetType !== 'Shared')) {
            unallocatedExpenses.push(exp);
            return;
        }

        if (exp.allocationTargetType === 'Shared' || exp.category === 'Shared_Overhead') {
            sharedExpenses.push(exp);
            return;
        }

        let targetBusId = exp.bus ? String(exp.bus) : null;
        if (!targetBusId && exp.route) {
            const matchedRoute = routes.find(r => String(r._id) === String(exp.route));
            if (matchedRoute?.assignedBus) {
                targetBusId = String(matchedRoute.assignedBus._id || matchedRoute.assignedBus);
            }
        }

        if (targetBusId && busMetricsMap[targetBusId]) {
            const bm = busMetricsMap[targetBusId];
            if (exp.category === 'Fuel') bm.fuelCost = addMoney(bm.fuelCost, amt);
            else if (exp.category === 'Toll_FASTag') bm.tollFastagCost = addMoney(bm.tollFastagCost, amt);
            else if (exp.category === 'Payroll') bm.directStaffCost = addMoney(bm.directStaffCost, amt);
            else if (exp.category === 'Maintenance') bm.maintenanceCost = addMoney(bm.maintenanceCost, amt);
            else if (['Insurance', 'Permit_Tax_Fitness', 'Lease_EMI', 'GPS_Technology'].includes(exp.category)) {
                bm.fixedVehicleCost = addMoney(bm.fixedVehicleCost, amt);
            } else if (exp.category === 'Depreciation') {
                bm.depreciationCost = addMoney(bm.depreciationCost, amt);
                if (includeDepreciation) bm.fixedVehicleCost = addMoney(bm.fixedVehicleCost, amt);
            } else {
                bm.otherVariableCost = addMoney(bm.otherVariableCost, amt);
            }
        } else {
            unallocatedExpenses.push(exp);
        }
    });

    // Resolve effective KM per bus before shared allocation
    const busKeys = Object.keys(busMetricsMap);
    busKeys.forEach(bId => {
        const bm = busMetricsMap[bId];
        if (bm.actualPeriodKm > 0) {
            bm.effectivePeriodKm = roundMoney(bm.actualPeriodKm);
            bm.kmSource = 'ActualOdometer';
        } else {
            bm.effectivePeriodKm = bm.plannedPeriodKm;
            bm.kmSource = 'PlannedRouteKm';
        }
    });

    // Allocate Shared Overhead Expenses across active buses using explicit rule (ByKm, ByBusCount, ByStudentCount, Equal)
    const totalFleetKm = busKeys.reduce((s, k) => s + (busMetricsMap[k].effectivePeriodKm || 0), 0);
    const totalFleetStudents = busKeys.reduce((s, k) => s + (busMetricsMap[k].capacity.occupiedSeats || 0), 0);
    const activeBusCount = Math.max(1, busKeys.length);

    sharedExpenses.forEach(exp => {
        const amt = roundMoney(exp.amount);
        const method = exp.sharedAllocationMethod || 'ByKm';

        busKeys.forEach(bId => {
            const bm = busMetricsMap[bId];
            let shareRatio = 1 / activeBusCount;
            if (method === 'ByKm' && totalFleetKm > 0) {
                shareRatio = bm.effectivePeriodKm / totalFleetKm;
            } else if (method === 'ByStudentCount' && totalFleetStudents > 0) {
                shareRatio = bm.capacity.occupiedSeats / totalFleetStudents;
            }
            const allocatedShare = mulMoney(amt, shareRatio);
            bm.sharedOverheadCost = addMoney(bm.sharedOverheadCost, allocatedShare);
        });
    });

    // 9. Finalize per-bus profitability, break-even & status flags
    const alerts = [];
    const fleetMileageValues = [];

    const busFinancials = busKeys.map(bId => {
        const bm = busMetricsMap[bId];
        const occ = bm.capacity.occupiedSeats;
        const usable = bm.capacity.usableCapacity;

        // Period revenue uses Billed Revenue if demands were generated, otherwise Accrued Subscription Revenue
        if (hasPostedDemands || bm.billedRevenue > 0) {
            bm.periodRevenue = bm.billedRevenue;
            bm.revenueSource = 'PostedDemands';
        } else {
            bm.periodRevenue = bm.accruedSubscriptionRevenue;
            bm.revenueSource = 'AccruedSubscriptions';
        }

        bm.directVariableCost = addMoney(bm.fuelCost, bm.tollFastagCost, bm.otherVariableCost);
        bm.totalOperatingCost = addMoney(
            bm.directVariableCost,
            bm.directStaffCost,
            bm.maintenanceCost,
            bm.fixedVehicleCost,
            bm.sharedOverheadCost
        );

        bm.operatingContribution = subMoney(bm.periodRevenue, bm.totalOperatingCost);
        bm.contributionMarginPercent = bm.periodRevenue > 0
            ? Number(((bm.operatingContribution / bm.periodRevenue) * 100).toFixed(1))
            : (bm.totalOperatingCost > 0 ? -100 : 0);

        bm.costPerKm = bm.effectivePeriodKm > 0 ? divMoney(bm.totalOperatingCost, bm.effectivePeriodKm) : 0;
        bm.revenuePerKm = bm.effectivePeriodKm > 0 ? divMoney(bm.periodRevenue, bm.effectivePeriodKm) : 0;
        bm.costPerStudent = occ > 0 ? divMoney(bm.totalOperatingCost, occ) : 0;
        bm.revenuePerStudent = occ > 0 ? divMoney(bm.periodRevenue, occ) : 0;
        bm.avgMonthlyFeePerStudent = bm.revenuePerStudent > 0
            ? bm.revenuePerStudent
            : (occ > 0 ? divMoney(bm.accruedSubscriptionRevenue, occ) : 2000);

        bm.breakEvenStudents = bm.avgMonthlyFeePerStudent > 0 && bm.totalOperatingCost > 0
            ? Math.ceil(bm.totalOperatingCost / bm.avgMonthlyFeePerStudent)
            : 0;
        bm.breakEvenOccupancyPercent = usable > 0 && bm.breakEvenStudents > 0
            ? Number(((bm.breakEvenStudents / usable) * 100).toFixed(1))
            : 0;

        if (bm.fuelQuantity > 0 && bm.effectivePeriodKm > 0) {
            bm.avgMileage = Number((bm.effectivePeriodKm / bm.fuelQuantity).toFixed(2));
            fleetMileageValues.push(bm.avgMileage);
        }

        // Status flags & Alerts
        if (bm.capacity.isOverCapacity) {
            bm.statusFlags.push('Over Capacity');
            alerts.push({
                id: `overcap-${bId}`,
                severity: 'critical',
                category: 'Capacity',
                title: `${bm.displayCode} (${bm.carNumber}) is Over Capacity`,
                description: `${occ}/${usable} usable seats occupied (${bm.capacity.overCapacityCount} excess). Immediate reallocation required.`,
                busId: bId,
                routeId: bm.routeId
            });
        } else if (bm.capacity.isFull) {
            bm.statusFlags.push('Full');
        } else if (bm.capacity.occupancyPercent >= nearlyFullThreshold) {
            bm.statusFlags.push('Nearly Full');
        } else if (bm.capacity.occupancyPercent < minOccupancyThreshold) {
            bm.statusFlags.push('Underutilized');
            alerts.push({
                id: `underutil-${bId}`,
                severity: 'warning',
                category: 'Utilization',
                title: `${bm.displayCode} Underutilized (${bm.capacity.occupancyPercent}%)`,
                description: `${bm.capacity.availableSeats} spare seats available on ${bm.routeName}. Target minimum occupancy is ${minOccupancyThreshold}%.`,
                busId: bId,
                routeId: bm.routeId
            });
        }

        if (bm.operatingContribution < 0) {
            bm.statusFlags.push('Loss-Making');
            alerts.push({
                id: `loss-${bId}`,
                severity: 'critical',
                category: 'Profitability',
                title: `${bm.routeName} (${bm.displayCode}) is Loss-Making`,
                description: `Monthly deficit of ₹${Math.abs(bm.operatingContribution).toLocaleString('en-IN')} (Revenue ₹${bm.periodRevenue.toLocaleString('en-IN')} vs Cost ₹${bm.totalOperatingCost.toLocaleString('en-IN')}). Needs ${Math.max(0, bm.breakEvenStudents - occ)} more students to break even.`,
                busId: bId,
                routeId: bm.routeId
            });
        }

        if (bm.statusFlags.includes('Over Capacity') || bm.statusFlags.includes('Loss-Making')) {
            bm.overallHealth = 'Critical';
        } else if (bm.statusFlags.includes('Underutilized') || bm.statusFlags.includes('Full')) {
            bm.overallHealth = 'Warning';
        } else {
            bm.overallHealth = 'Healthy';
        }

        // Field aliases for UI & test compatibility
        bm._id = bm.busId;
        bm.busNumber = bm.displayCode || bm.carNumber;
        bm.vehicleNumber = bm.carNumber;
        bm.registrationNumber = bm.carNumber;
        bm.occupiedSeats = occ;
        bm.usableCapacity = usable;
        bm.availableSeats = bm.capacity.availableSeats;
        bm.occupancyPercent = bm.capacity.occupancyPercent;
        bm.grossTransportFee = bm.grossRevenue || bm.periodRevenue;
        bm.discountsAndWaivers = bm.discountsAndWaivers || 0;
        bm.creditAdjustments = bm.creditAdjustments || 0;
        bm.netBilledTransportRevenue = bm.periodRevenue;
        bm.payrollCost = bm.directStaffCost;
        bm.routineMaintenanceCost = bm.maintenanceCost;
        bm.directOtherExpense = addMoney(bm.tollFastagCost, bm.otherVariableCost);
        bm.amortizedFixedCost = bm.fixedVehicleCost;
        bm.allocatedSharedCost = bm.sharedOverheadCost;
        bm.netOperatingContribution = bm.operatingContribution;
        bm.contributionMarginPct = bm.contributionMarginPercent;
        bm.collectionEfficiencyPct = bm.periodRevenue > 0
            ? Number(((bm.cashCollected / bm.periodRevenue) * 100).toFixed(1))
            : 0;
        bm.outstandingReceivable = bm.totalOutstanding;
        bm.breakEvenOccupancyPct = bm.breakEvenOccupancyPercent;
        bm.profitabilityStatus = bm.operatingContribution > 1000
            ? 'Profitable'
            : bm.operatingContribution >= 0
                ? 'Near Break-Even'
                : 'Loss-Making';

        return bm;
    });

    // Check abnormal mileage across fleet
    if (fleetMileageValues.length >= 2) {
        const fleetAvgMileage = fleetMileageValues.reduce((a, b) => a + b, 0) / fleetMileageValues.length;
        busFinancials.forEach(bm => {
            if (bm.avgMileage > 0) {
                const deviation = ((fleetAvgMileage - bm.avgMileage) / fleetAvgMileage) * 100;
                if (deviation >= mileageDeviationThreshold) {
                    alerts.push({
                        id: `mileage-${bm.busId}`,
                        severity: 'warning',
                        category: 'Fuel Anomaly',
                        title: `Abnormal Mileage on ${bm.displayCode} (${bm.avgMileage} km/L)`,
                        description: `${deviation.toFixed(1)}% below fleet average (${fleetAvgMileage.toFixed(1)} km/L). Fuel cost/km is ₹${bm.costPerKm}.`,
                        busId: bm.busId
                    });
                }
            }
        });
    }

    // Check missing subscriptions & missing geocodes
    const activeSubStudentIds = new Set(activeSubscriptions.map(s => String(s.student)));
    const studentsWithoutSub = allStudents.filter(
        s => s.assignedBus && s.transportStatus !== 'Non-Transport' && !activeSubStudentIds.has(String(s._id))
    );
    if (studentsWithoutSub.length > 0) {
        alerts.push({
            id: 'missing-subs',
            severity: 'warning',
            category: 'Finance Integrity',
            title: `${studentsWithoutSub.length} Transport Student(s) Missing Active Fee Subscription`,
            description: `Students assigned to buses without an active fee subscription: ${studentsWithoutSub.slice(0, 3).map(s => s.name).join(', ')}.`
        });
    }

    const studentsMissingCoords = allStudents.filter(
        s => s.assignedBus && (!s.pickupLat || !s.pickupLng)
    );
    if (studentsMissingCoords.length > 0) {
        alerts.push({
            id: 'missing-geocode',
            severity: 'info',
            category: 'Data Quality',
            title: `${studentsMissingCoords.length} Student Pickup Point(s) Missing Map Coordinates`,
            description: `Geocode student addresses in Students / Route Optimizer to improve detour accuracy.`
        });
    }

    if (unallocatedExpenses.length > 0) {
        const unallocTotal = unallocatedExpenses.reduce((s, e) => addMoney(s, e.amount), 0);
        alerts.push({
            id: 'unallocated-exp',
            severity: 'warning',
            category: 'Cost Allocation',
            title: `${unallocatedExpenses.length} Unallocated Transport Expense(s) (₹${unallocTotal.toLocaleString('en-IN')})`,
            description: `Assign target Bus, Route, or Shared Allocation Rule in Expenses so route profitability is complete.`
        });
    }

    // 10. Build Route-Level Summary
    const routeSummaryList = routes.map(r => {
        const assignedBusId = r.assignedBus ? String(r.assignedBus._id || r.assignedBus) : null;
        const linkedBusMetrics = assignedBusId ? busMetricsMap[assignedBusId] : null;
        const stopsCount = Array.isArray(r.stops) ? r.stops.length : 0;

        if (linkedBusMetrics) {
            return {
                routeId: r._id,
                routeName: r.name,
                routeCode: r.code || `RT-${String(r.name).slice(0, 4).toUpperCase()}`,
                shift: r.shift,
                direction: r.direction || 'RoundTrip',
                stopsCount,
                plannedDailyKm: Number(r.plannedKm) || 28,
                dailyKm: Number(r.plannedKm) || 28,
                plannedMinutes: Number(r.plannedMinutes) || 45,
                busId: linkedBusMetrics.busId,
                busDisplayCode: linkedBusMetrics.displayCode,
                busNumber: linkedBusMetrics.displayCode || linkedBusMetrics.carNumber,
                carNumber: linkedBusMetrics.carNumber,
                usableCapacity: linkedBusMetrics.capacity.usableCapacity,
                occupiedSeats: linkedBusMetrics.capacity.occupiedSeats,
                availableSeats: linkedBusMetrics.capacity.availableSeats,
                occupancyPercent: linkedBusMetrics.capacity.occupancyPercent,
                periodKm: linkedBusMetrics.effectivePeriodKm,
                monthlyKm: linkedBusMetrics.effectivePeriodKm,
                kmSource: linkedBusMetrics.kmSource,
                periodRevenue: linkedBusMetrics.periodRevenue,
                netBilledRevenue: linkedBusMetrics.periodRevenue,
                cashCollected: linkedBusMetrics.cashCollected,
                totalOutstanding: linkedBusMetrics.totalOutstanding,
                totalOperatingCost: linkedBusMetrics.totalOperatingCost,
                totalCost: linkedBusMetrics.totalOperatingCost,
                directVariableCost: linkedBusMetrics.directVariableCost,
                directStaffCost: linkedBusMetrics.directStaffCost,
                maintenanceCost: linkedBusMetrics.maintenanceCost,
                fixedVehicleCost: linkedBusMetrics.fixedVehicleCost,
                sharedOverheadCost: linkedBusMetrics.sharedOverheadCost,
                operatingContribution: linkedBusMetrics.operatingContribution,
                contribution: linkedBusMetrics.operatingContribution,
                contributionMarginPercent: linkedBusMetrics.contributionMarginPercent,
                marginPct: linkedBusMetrics.contributionMarginPercent,
                costPerKm: linkedBusMetrics.costPerKm,
                revenuePerKm: linkedBusMetrics.revenuePerKm,
                costPerStudent: linkedBusMetrics.costPerStudent,
                revenuePerStudent: linkedBusMetrics.revenuePerStudent,
                breakEvenStudents: linkedBusMetrics.breakEvenStudents,
                breakEvenOccupancyPercent: linkedBusMetrics.breakEvenOccupancyPercent,
                breakEvenOccupancyPct: linkedBusMetrics.breakEvenOccupancyPercent,
                statusFlags: linkedBusMetrics.statusFlags,
                overallHealth: linkedBusMetrics.overallHealth,
                status: linkedBusMetrics.profitabilityStatus
            };
        }

        return {
            routeId: r._id,
            routeName: r.name,
            routeCode: r.code || 'RT',
            shift: r.shift,
            direction: r.direction || 'RoundTrip',
            stopsCount,
            plannedDailyKm: Number(r.plannedKm) || 0,
            dailyKm: Number(r.plannedKm) || 0,
            plannedMinutes: Number(r.plannedMinutes) || 0,
            busId: null,
            busDisplayCode: 'Unassigned',
            busNumber: 'Unassigned',
            carNumber: 'No Bus',
            usableCapacity: 0,
            occupiedSeats: 0,
            availableSeats: 0,
            occupancyPercent: 0,
            periodKm: 0,
            monthlyKm: 0,
            kmSource: 'None',
            periodRevenue: 0,
            netBilledRevenue: 0,
            cashCollected: 0,
            totalOutstanding: 0,
            totalOperatingCost: 0,
            totalCost: 0,
            directVariableCost: 0,
            directStaffCost: 0,
            maintenanceCost: 0,
            fixedVehicleCost: 0,
            sharedOverheadCost: 0,
            operatingContribution: 0,
            contribution: 0,
            contributionMarginPercent: 0,
            marginPct: 0,
            costPerKm: 0,
            revenuePerKm: 0,
            costPerStudent: 0,
            revenuePerStudent: 0,
            breakEvenStudents: 0,
            breakEvenOccupancyPercent: 0,
            breakEvenOccupancyPct: 0,
            statusFlags: ['Missing Bus'],
            overallHealth: 'Warning',
            status: 'Near Break-Even'
        };
    });

    // 11. School-Wide Financial & Operating Totals
    const totalBilledRevenue = busFinancials.reduce((s, b) => addMoney(s, b.periodRevenue), 0);
    const totalCashCollected = periodReceipts.reduce(
        (s, r) => addMoney(s, subMoney(roundMoney(r.amount), roundMoney(r.refundedAmount || 0))),
        0
    );
    const totalOutstanding = allOpenDemands.reduce((s, d) => addMoney(s, roundMoney(d.outstandingAmount)), 0);
    const totalFuelCost = busFinancials.reduce((s, b) => addMoney(s, b.fuelCost), 0);
    const totalTollCost = busFinancials.reduce((s, b) => addMoney(s, b.tollFastagCost), 0);
    const totalPayrollCost = busFinancials.reduce((s, b) => addMoney(s, b.directStaffCost), 0);
    const totalMaintenanceCost = busFinancials.reduce((s, b) => addMoney(s, b.maintenanceCost), 0);
    const totalFixedCost = busFinancials.reduce((s, b) => addMoney(s, b.fixedVehicleCost), 0);
    const totalSharedOverhead = busFinancials.reduce((s, b) => addMoney(s, b.sharedOverheadCost), 0);
    const totalUnallocatedExpense = unallocatedExpenses.reduce((s, e) => addMoney(s, roundMoney(e.amount)), 0);

    const totalOperatingCost = addMoney(
        totalFuelCost,
        totalTollCost,
        totalPayrollCost,
        totalMaintenanceCost,
        totalFixedCost,
        totalSharedOverhead
    );
    const operatingContribution = subMoney(totalBilledRevenue, totalOperatingCost);
    const contributionMarginPercent = totalBilledRevenue > 0
        ? Number(((operatingContribution / totalBilledRevenue) * 100).toFixed(1))
        : 0;
    const collectionEfficiencyPct = totalBilledRevenue > 0
        ? Number(((totalCashCollected / totalBilledRevenue) * 100).toFixed(1))
        : 0;

    if (totalOutstanding >= overdueThreshold) {
        alerts.push({
            id: 'school-overdue',
            severity: 'warning',
            category: 'Receivables',
            title: `Total Transport Outstanding ₹${totalOutstanding.toLocaleString('en-IN')}`,
            description: `Exceeds school threshold of ₹${overdueThreshold.toLocaleString('en-IN')}. Follow up in Collections.`
        });
    }

    const enrichedAlerts = alerts.map(a => ({
        ...a,
        type: a.category,
        entity: a.title,
        message: a.description
    }));

    const activeStudentsCount = fleetSnapshot.summary.totalOccupiedSeats;

    return {
        periodKey: p.periodKey,
        month: p.monthName,
        year: p.year,
        timezone: company?.timezone || 'Asia/Kolkata',
        metadata: {
            revenueRecognitionBasis: hasPostedDemands ? 'Posted Period Demands (Accrual)' : 'Active Fee Subscriptions (Accrued Monthly Equivalent)',
            cashCollectionNote: 'Cash Collected reflects actual receipts in the period and is tracked separately from Billed Revenue.',
            sharedAllocationDefault: 'ByKm / Explicit Rule',
            includeDepreciation
        },
        schoolSummary: {
            billedTransportRevenue: totalBilledRevenue,
            cashCollected: totalCashCollected,
            collectionEfficiencyPct,
            outstandingReceivables: totalOutstanding,
            outstandingReceivable: totalOutstanding,
            totalOperatingCost,
            totalTransportCost: totalOperatingCost,
            operatingContribution,
            netTransportContribution: operatingContribution,
            contributionMarginPercent,
            contributionMarginPct: contributionMarginPercent,
            monthlyPayroll: totalPayrollCost,
            monthlyFuel: totalFuelCost,
            monthlyMaintenance: totalMaintenanceCost,
            monthlyTollFastag: totalTollCost,
            monthlyFixedCost: totalFixedCost,
            monthlySharedOverhead: totalSharedOverhead,
            unallocatedExpenseTotal: totalUnallocatedExpense,
            fleetSize: fleetSnapshot.summary.fleetSize,
            activeBuses: fleetSnapshot.summary.fleetSize,
            activeRoutes: routeSummaryList.length,
            totalSeats: fleetSnapshot.summary.totalFleetSeats,
            usableCapacity: fleetSnapshot.summary.totalUsableCapacity,
            totalUsableCapacity: fleetSnapshot.summary.totalUsableCapacity,
            occupiedSeats: fleetSnapshot.summary.totalOccupiedSeats,
            availableSeats: fleetSnapshot.summary.totalAvailableSeats,
            fleetUtilizationPercent: fleetSnapshot.summary.fleetUtilizationPercent,
            fleetOccupancyPct: fleetSnapshot.summary.fleetUtilizationPercent,
            lossMakingRoutesCount: busFinancials.filter(b => b.operatingContribution < 0).length,
            costPerStudent: activeStudentsCount > 0 ? divMoney(totalOperatingCost, activeStudentsCount) : 0,
            revenuePerStudent: activeStudentsCount > 0 ? divMoney(totalBilledRevenue, activeStudentsCount) : 0,
            costPerKm: totalFleetKm > 0 ? divMoney(totalOperatingCost, totalFleetKm) : 0,
            revenuePerKm: totalFleetKm > 0 ? divMoney(totalBilledRevenue, totalFleetKm) : 0
        },
        costMix: [
            { category: 'Payroll (Drivers & Conductors)', amount: totalPayrollCost },
            { category: 'Fuel (Diesel/CNG/EV)', amount: totalFuelCost },
            { category: 'Maintenance & Tyres', amount: totalMaintenanceCost },
            { category: 'Fixed Costs (Insurance/Permit/Tax/EMI)', amount: totalFixedCost },
            { category: 'Tolls & FASTag', amount: totalTollCost },
            { category: 'Shared Overhead', amount: totalSharedOverhead }
        ],
        busSummary: busFinancials,
        busStatements: busFinancials,
        routeSummary: routeSummaryList,
        routeStatements: routeSummaryList,
        unallocatedExpenses,
        alerts: enrichedAlerts
    };
};

module.exports = {
    calculateTransportProfitability
};
