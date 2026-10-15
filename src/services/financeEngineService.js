const FeePlan = require('../models/FeePlan');
const StudentFeeSubscription = require('../models/StudentFeeSubscription');
const TransportAssignment = require('../models/TransportAssignment');
const TransportDemand = require('../models/TransportDemand');
const TransportReceipt = require('../models/TransportReceipt');
const ReceiptAllocation = require('../models/ReceiptAllocation');
const TransportLedgerEntry = require('../models/TransportLedgerEntry');
const FeeRecord = require('../models/FeeRecord');
const Student = require('../models/Student');
const Route = require('../models/Route');
const {
    roundMoney,
    addMoney,
    subMoney,
    mulMoney,
    divMoney,
    parsePeriod
} = require('../utils/moneyUtils');
const { ensureBaselineAssignments } = require('./capacityService');
const { logAudit } = require('../utils/auditLogger');

/**
 * Recompute chronological running balance for a student's ledger entries
 */
const recomputeStudentRunningBalance = async (companyId, studentId) => {
    const entries = await TransportLedgerEntry.find({
        company: companyId,
        student: studentId
    }).sort({ entryDate: 1, createdAt: 1 });

    let running = 0;
    for (const entry of entries) {
        running = subMoney(addMoney(running, entry.debit || 0), entry.credit || 0);
        if (roundMoney(entry.runningBalance) !== running) {
            entry.runningBalance = running;
            await entry.save();
        }
    }
    return running;
};

/**
 * Sync TransportDemand with legacy FeeRecord collection for backward compatibility
 */
const syncLegacyFeeRecord = async (demand) => {
    try {
        await FeeRecord.findOneAndUpdate(
            {
                student: demand.student,
                month: demand.month,
                year: demand.year
            },
            {
                student: demand.student,
                company: demand.company,
                month: demand.month,
                year: demand.year,
                amountPaid: roundMoney(demand.allocatedAmount),
                amountPending: roundMoney(demand.outstandingAmount),
                status: demand.status === 'Paid' ? 'Paid' : demand.allocatedAmount > 0 ? 'Partial' : 'Pending',
                paymentDate: demand.allocatedAmount > 0 ? new Date() : null
            },
            { upsert: true, new: true }
        );
    } catch (e) {
        // Non-blocking sync
    }
};

/**
 * Calculate proration factor and explanation for mid-period enrollment/withdrawal
 */
const calculateProration = ({
    prorationRule = 'DailyProrata',
    periodStartDate,
    periodEndDate,
    daysInMonth,
    effectiveFrom,
    effectiveTo
}) => {
    const start = effectiveFrom && new Date(effectiveFrom) > periodStartDate
        ? new Date(effectiveFrom)
        : periodStartDate;
    const end = effectiveTo && new Date(effectiveTo) < periodEndDate
        ? new Date(effectiveTo)
        : periodEndDate;

    if (end < start) {
        return { factor: 0, activeDays: 0, note: 'No active days in period' };
    }

    const msPerDay = 1000 * 60 * 60 * 24;
    const activeDays = Math.min(
        daysInMonth,
        Math.max(1, Math.floor((end.getTime() - start.getTime()) / msPerDay) + 1)
    );

    if (activeDays >= daysInMonth || prorationRule === 'FullMonth') {
        return {
            factor: 1,
            activeDays,
            note: `Full month charge (${activeDays}/${daysInMonth} days, rule: ${prorationRule})`
        };
    }

    if (prorationRule === 'HalfMonthThreshold') {
        const factor = activeDays > 15 ? 1 : 0.5;
        return {
            factor,
            activeDays,
            note: `Half-month rule: ${activeDays} active days -> ${factor * 100}% charge`
        };
    }

    // Default: DailyProrata
    const factor = Number((activeDays / daysInMonth).toFixed(4));
    return {
        factor,
        activeDays,
        note: `Daily pro-rata: ${activeDays}/${daysInMonth} active days (${(factor * 100).toFixed(1)}%)`
    };
};

/**
 * Generate Periodic Transport Fee Demands for all active subscriptions (or a specific student)
 */
const generatePeriodDemands = async ({
    companyId,
    period,
    month,
    year,
    studentId = null,
    applyProration = true,
    user = null
}) => {
    await ensureBaselineAssignments(companyId);
    const p = parsePeriod(period, month, year);

    const subQuery = {
        company: companyId,
        status: 'Active',
        effectiveFrom: { $lte: p.endDate },
        $or: [
            { effectiveTo: null },
            { effectiveTo: { $gte: p.startDate } }
        ]
    };
    if (studentId) subQuery.student = studentId;

    const [subscriptions, existingDemandsList, periodAssignments, companyRoutes, allAdvanceReceipts] = await Promise.all([
        StudentFeeSubscription.find(subQuery)
            .populate('student')
            .populate('feePlan')
            .lean(),
        TransportDemand.find({
            company: companyId,
            periodKey: p.periodKey,
            isOpeningBalance: false,
            status: { $nin: ['Cancelled', 'Reversed'] }
        }).lean(),
        TransportAssignment.find({
            company: companyId,
            effectiveFrom: { $lte: p.endDate },
            $or: [{ effectiveTo: null }, { effectiveTo: { $gte: p.startDate } }]
        }).sort({ effectiveFrom: -1 }).lean(),
        Route.find({ company: companyId }).lean(),
        TransportReceipt.find({
            company: companyId,
            unallocatedAdvance: { $gt: 0 },
            status: { $in: ['Posted', 'PartiallyAllocated'] }
        }).sort({ receiptDate: 1 })
    ]);

    const existingDemandByStu = new Map();
    existingDemandsList.forEach(d => existingDemandByStu.set(String(d.student), d));

    const assignmentByStu = new Map();
    periodAssignments.forEach(a => {
        const k = String(a.student);
        if (!assignmentByStu.has(k)) assignmentByStu.set(k, a);
    });

    const routeByBus = new Map();
    companyRoutes.forEach(r => {
        if (r.assignedBus) routeByBus.set(String(r.assignedBus), r._id);
    });

    const advancesByStu = new Map();
    allAdvanceReceipts.forEach(r => {
        const k = String(r.student);
        if (!advancesByStu.has(k)) advancesByStu.set(k, []);
        advancesByStu.get(k).push(r);
    });

    const createdDemands = [];
    const skippedDemands = [];

    for (const sub of subscriptions) {
        if (!sub.student || sub.student.status === 'inactive' || sub.student.transportStatus === 'Withdrawn') {
            continue;
        }

        const stuIdStr = String(sub.student._id);
        const existingDemand = existingDemandByStu.get(stuIdStr);

        if (existingDemand) {
            skippedDemands.push(existingDemand);
            continue;
        }

        const assignment = assignmentByStu.get(stuIdStr);

        let routeId = assignment?.route || sub.route || sub.student.assignedRoute || null;
        const busId = assignment?.bus || sub.bus || sub.student.assignedBus || null;
        if (!routeId && busId) {
            routeId = routeByBus.get(String(busId)) || null;
        }

        const prorationRule = sub.feePlan?.prorationRule || 'DailyProrata';
        const proration = applyProration
            ? calculateProration({
                prorationRule,
                periodStartDate: p.startDate,
                periodEndDate: p.endDate,
                daysInMonth: p.daysInMonth,
                effectiveFrom: sub.effectiveFrom || assignment?.effectiveFrom,
                effectiveTo: sub.effectiveTo || assignment?.effectiveTo
            })
            : { factor: 1, activeDays: p.daysInMonth, note: 'Standard monthly billing' };

        if (proration.factor <= 0) continue;

        const baseMonthly = roundMoney(sub.monthlyEquivalentAmount || sub.netPeriodicAmount || sub.standardAmount || sub.student.feeAmount || 0);
        const stdMonthly = roundMoney(sub.overrideAmount !== null && sub.overrideAmount !== undefined ? sub.overrideAmount : (sub.standardAmount || baseMonthly));
        const proratedGross = mulMoney(stdMonthly, proration.factor);
        const proratedDiscount = mulMoney(sub.discountAmount || 0, proration.factor);
        const taxableBase = Math.max(0, subMoney(proratedGross, proratedDiscount));
        const taxPercent = Number(sub.feePlan?.taxPercent) || 0;
        const taxAmount = taxPercent > 0 ? mulMoney(taxableBase, taxPercent / 100) : 0;
        const netAmount = addMoney(taxableBase, taxAmount);

        const dueDay = Number(sub.feePlan?.dueDayOfMonth) || 10;
        const dueDate = new Date(Date.UTC(p.year, p.monthNum - 1, Math.min(28, dueDay), 18, 29, 59));
        const randomSuffix = String(Math.floor(1000 + Math.random() * 9000));
        const demandNo = `DEM-${p.periodKey.replace('-', '')}-${String(sub.student._id).slice(-4).toUpperCase()}-${randomSuffix}`;

        const demand = await TransportDemand.create({
            company: companyId,
            demandNo,
            student: sub.student._id,
            subscription: sub._id,
            feePlan: sub.feePlan?._id || null,
            attributedBus: busId,
            attributedRoute: routeId,
            periodKey: p.periodKey,
            month: p.monthName,
            year: p.year,
            grossAmount: proratedGross,
            discountAmount: proratedDiscount,
            discountReason: sub.discountType !== 'None' ? `${sub.discountType} Discount` : '',
            prorationFactor: proration.factor,
            prorationCalculationNote: proration.note,
            isProrated: proration.factor < 1,
            prorationDays: proration.activeDays,
            totalPeriodDays: p.daysInMonth,
            taxAmount,
            netAmount,
            allocatedAmount: 0,
            outstandingAmount: netAmount,
            dueDate,
            status: netAmount <= 0 ? 'Paid' : 'Pending',
            createdBy: user?._id || null
        });

        await TransportLedgerEntry.create({
            company: companyId,
            student: sub.student._id,
            entryDate: p.startDate,
            periodKey: p.periodKey,
            entryType: 'Demand',
            referenceType: 'TransportDemand',
            referenceId: demand._id,
            referenceNo: demand.demandNo,
            description: `Transport Fee Demand for ${p.monthName} ${p.year} (${proration.note})`,
            debit: netAmount,
            credit: 0,
            runningBalance: netAmount,
            reason: proration.note,
            actor: user?._id || null
        });

        // Auto-apply any unallocated advance receipts for this student
        const advanceReceipts = advancesByStu.get(stuIdStr) || [];

        for (const receipt of advanceReceipts) {
            if (demand.outstandingAmount <= 0) break;
            const availAdv = roundMoney(receipt.unallocatedAdvance);
            if (availAdv <= 0) continue;

            const allocAmt = Math.min(availAdv, roundMoney(demand.outstandingAmount));
            await ReceiptAllocation.create({
                company: companyId,
                receipt: receipt._id,
                demand: demand._id,
                student: sub.student._id,
                allocatedAmount: allocAmt,
                allocatedBy: user?._id || null
            });

            receipt.allocatedAmount = addMoney(receipt.allocatedAmount, allocAmt);
            receipt.unallocatedAdvance = subMoney(receipt.unallocatedAdvance, allocAmt);
            receipt.status = receipt.unallocatedAdvance <= 0 ? 'FullyAllocated' : 'PartiallyAllocated';
            await receipt.save();

            demand.allocatedAmount = addMoney(demand.allocatedAmount, allocAmt);
            demand.outstandingAmount = subMoney(demand.netAmount, demand.allocatedAmount);
            demand.status = demand.outstandingAmount <= 0 ? 'Paid' : 'Partial';
            await demand.save();
        }

        await recomputeStudentRunningBalance(companyId, sub.student._id);
        await syncLegacyFeeRecord(demand);
        createdDemands.push(demand);
    }

    if (createdDemands.length > 0) {
        await logAudit({
            company: companyId,
            user,
            action: 'BILLING_DEMANDS_GENERATED',
            entityType: 'TransportDemand',
            entityId: p.periodKey,
            afterState: { periodKey: p.periodKey, count: createdDemands.length },
            reason: `Generated ${createdDemands.length} demands for ${p.monthName} ${p.year}`
        });
    }

    return {
        periodKey: p.periodKey,
        month: p.monthName,
        year: p.year,
        createdCount: createdDemands.length,
        skippedCount: skippedDemands.length,
        createdDemands
    };
};

/**
 * Apply Debit/Credit Adjustment or Waiver to an existing Demand (Section 4.3 & Section 5)
 */
const applyDemandAdjustment = async ({
    companyId,
    demandId,
    adjustmentType, // 'CreditAdjustment' | 'DebitAdjustment' | 'Waiver'
    amount,
    reason,
    user = null
}) => {
    const adjAmt = roundMoney(amount);
    if (adjAmt <= 0) {
        const err = new Error('Adjustment amount must be greater than 0');
        err.statusCode = 400;
        throw err;
    }
    if (!reason || !String(reason).trim()) {
        const err = new Error('Audit reason is mandatory for financial adjustments/waivers');
        err.statusCode = 400;
        throw err;
    }

    const demand = await TransportDemand.findOne({ _id: demandId, company: companyId });
    if (!demand) {
        const err = new Error('Transport demand not found');
        err.statusCode = 404;
        throw err;
    }
    if (demand.isPeriodLocked) {
        const err = new Error('Financial period is locked; historical demand cannot be modified');
        err.statusCode = 403;
        throw err;
    }

    const beforeState = {
        netAmount: demand.netAmount,
        discountAmount: demand.discountAmount,
        creditAdjustment: demand.creditAdjustment,
        debitAdjustment: demand.debitAdjustment,
        outstandingAmount: demand.outstandingAmount,
        status: demand.status
    };

    if (adjustmentType === 'DebitAdjustment') {
        demand.debitAdjustment = addMoney(demand.debitAdjustment, adjAmt);
        demand.netAmount = addMoney(demand.netAmount, adjAmt);
    } else if (adjustmentType === 'Waiver') {
        demand.discountAmount = addMoney(demand.discountAmount, adjAmt);
        demand.discountReason = demand.discountReason
            ? `${demand.discountReason}; Waiver: ${reason}`
            : `Waiver: ${reason}`;
        demand.netAmount = Math.max(0, subMoney(demand.netAmount, adjAmt));
    } else {
        // CreditAdjustment
        demand.creditAdjustment = addMoney(demand.creditAdjustment, adjAmt);
        demand.netAmount = Math.max(0, subMoney(demand.netAmount, adjAmt));
    }

    demand.outstandingAmount = Math.max(0, subMoney(demand.netAmount, demand.allocatedAmount));
    demand.status = demand.outstandingAmount <= 0
        ? 'Paid'
        : demand.allocatedAmount > 0
            ? 'Partial'
            : 'Pending';

    await demand.save();

    await TransportLedgerEntry.create({
        company: companyId,
        student: demand.student,
        entryDate: new Date(),
        periodKey: demand.periodKey,
        entryType: adjustmentType === 'DebitAdjustment' ? 'DebitAdjustment' : adjustmentType === 'Waiver' ? 'Waiver' : 'CreditAdjustment',
        referenceType: 'TransportDemand',
        referenceId: demand._id,
        referenceNo: demand.demandNo,
        description: `${adjustmentType} on ${demand.demandNo}: ${reason}`,
        debit: adjustmentType === 'DebitAdjustment' ? adjAmt : 0,
        credit: adjustmentType !== 'DebitAdjustment' ? adjAmt : 0,
        runningBalance: 0,
        reason,
        actor: user?._id || null
    });

    await recomputeStudentRunningBalance(companyId, demand.student);
    await syncLegacyFeeRecord(demand);

    await logAudit({
        company: companyId,
        user,
        action: `DEMAND_${adjustmentType.toUpperCase()}`,
        entityType: 'TransportDemand',
        entityId: demand._id,
        beforeState,
        afterState: {
            netAmount: demand.netAmount,
            outstandingAmount: demand.outstandingAmount,
            status: demand.status
        },
        reason
    });

    return demand;
};

/**
 * Post a Student Transport Receipt with Idempotency, Partial/Multi-Demand Allocation & Advance Credit (Section 5, AC-05)
 */
const postTransportReceipt = async ({
    companyId,
    studentId,
    amount,
    receiptDate = new Date(),
    paymentMode = 'Cash',
    referenceNo = '',
    bankOrCashAccount = 'Main Transport Collection A/C',
    notes = '',
    allocations = [], // Optional explicit [{ demandId, amount }]. If omitted, auto-allocates FIFO to oldest unpaid demands
    autoAllocateFIFO = true,
    idempotencyKey = null,
    user = null
}) => {
    const rcptAmt = roundMoney(amount);
    if (rcptAmt <= 0) {
        const err = new Error('Receipt amount must be greater than 0');
        err.statusCode = 400;
        throw err;
    }

    // Idempotency check (Section 21 & Section 24)
    if (idempotencyKey) {
        const existingReceipt = await TransportReceipt.findOne({
            company: companyId,
            idempotencyKey
        });
        if (existingReceipt) {
            return { receipt: existingReceipt, duplicateIdempotent: true };
        }
    }

    const student = await Student.findOne({ _id: studentId, company: companyId });
    if (!student) {
        const err = new Error('Student not found');
        err.statusCode = 404;
        throw err;
    }

    const rDate = receiptDate ? new Date(receiptDate) : new Date();
    const p = parsePeriod(null, rDate.getMonth() + 1, rDate.getFullYear());
    const randomSuffix = String(Math.floor(1000 + Math.random() * 9000));
    const receiptNo = `RCPT-${p.periodKey.replace('-', '')}-${String(student._id).slice(-4).toUpperCase()}-${randomSuffix}`;

    const receipt = await TransportReceipt.create({
        company: companyId,
        receiptNo,
        idempotencyKey: idempotencyKey || receiptNo,
        student: student._id,
        receiptDate: rDate,
        periodKey: p.periodKey,
        amount: rcptAmt,
        allocatedAmount: 0,
        unallocatedAdvance: rcptAmt,
        paymentMode,
        referenceNo,
        bankOrCashAccount,
        notes,
        status: 'Posted',
        collectedBy: user?._id || null,
        collectorName: user?.name || 'Cashier/Admin'
    });

    // Record Receipt in Student Ledger (credit reduces student receivable; if > demand, runningBalance becomes negative = advance credit)
    await TransportLedgerEntry.create({
        company: companyId,
        student: student._id,
        entryDate: rDate,
        periodKey: p.periodKey,
        entryType: 'Receipt',
        referenceType: 'TransportReceipt',
        referenceId: receipt._id,
        referenceNo: receipt.receiptNo,
        description: `Fee Receipt ${receipt.receiptNo} via ${paymentMode}${referenceNo ? ` (Ref: ${referenceNo})` : ''}`,
        debit: 0,
        credit: rcptAmt,
        runningBalance: 0,
        reason: notes || 'Transport fee payment',
        actor: user?._id || null
    });

    const createdAllocations = [];
    let remainingToAllocate = rcptAmt;

    // 1. If explicit allocations passed, apply them first
    if (Array.isArray(allocations) && allocations.length > 0) {
        for (const item of allocations) {
            if (remainingToAllocate <= 0) break;
            const demand = await TransportDemand.findOne({
                _id: item.demandId,
                company: companyId,
                student: student._id,
                status: { $in: ['Pending', 'Partial'] }
            });
            if (!demand || demand.outstandingAmount <= 0) continue;

            const requested = item.amount ? roundMoney(item.amount) : roundMoney(demand.outstandingAmount);
            const allocAmt = Math.min(remainingToAllocate, requested, roundMoney(demand.outstandingAmount));
            if (allocAmt <= 0) continue;

            const allocDoc = await ReceiptAllocation.create({
                company: companyId,
                receipt: receipt._id,
                demand: demand._id,
                student: student._id,
                allocatedAmount: allocAmt,
                allocatedBy: user?._id || null
            });
            createdAllocations.push(allocDoc);

            demand.allocatedAmount = addMoney(demand.allocatedAmount, allocAmt);
            demand.outstandingAmount = Math.max(0, subMoney(demand.netAmount, demand.allocatedAmount));
            demand.status = demand.outstandingAmount <= 0 ? 'Paid' : 'Partial';
            await demand.save();
            await syncLegacyFeeRecord(demand);

            remainingToAllocate = subMoney(remainingToAllocate, allocAmt);
        }
    } else if (autoAllocateFIFO) {
        // 2. Otherwise auto-allocate FIFO across oldest unpaid demands
        const unpaidDemands = await TransportDemand.find({
            company: companyId,
            student: student._id,
            status: { $in: ['Pending', 'Partial'] },
            outstandingAmount: { $gt: 0 }
        }).sort({ dueDate: 1, createdAt: 1 });

        for (const demand of unpaidDemands) {
            if (remainingToAllocate <= 0) break;
            const allocAmt = Math.min(remainingToAllocate, roundMoney(demand.outstandingAmount));
            if (allocAmt <= 0) continue;

            const allocDoc = await ReceiptAllocation.create({
                company: companyId,
                receipt: receipt._id,
                demand: demand._id,
                student: student._id,
                allocatedAmount: allocAmt,
                allocatedBy: user?._id || null
            });
            createdAllocations.push(allocDoc);

            demand.allocatedAmount = addMoney(demand.allocatedAmount, allocAmt);
            demand.outstandingAmount = Math.max(0, subMoney(demand.netAmount, demand.allocatedAmount));
            demand.status = demand.outstandingAmount <= 0 ? 'Paid' : 'Partial';
            await demand.save();
            await syncLegacyFeeRecord(demand);

            remainingToAllocate = subMoney(remainingToAllocate, allocAmt);
        }
    }

    const totalAllocated = subMoney(rcptAmt, remainingToAllocate);
    receipt.allocatedAmount = totalAllocated;
    receipt.unallocatedAdvance = remainingToAllocate;
    receipt.status = remainingToAllocate <= 0
        ? 'FullyAllocated'
        : totalAllocated > 0
            ? 'PartiallyAllocated'
            : 'Posted';
    await receipt.save();

    await recomputeStudentRunningBalance(companyId, student._id);

    await logAudit({
        company: companyId,
        user,
        action: 'RECEIPT_POSTED',
        entityType: 'TransportReceipt',
        entityId: receipt._id,
        afterState: {
            receiptNo: receipt.receiptNo,
            amount: receipt.amount,
            allocatedAmount: receipt.allocatedAmount,
            unallocatedAdvance: receipt.unallocatedAdvance
        },
        reason: notes || 'Receipt posted'
    });

    return {
        receipt,
        allocations: createdAllocations,
        duplicateIdempotent: false
    };
};

/**
 * Allocate an existing Receipt's unallocated advance balance to one or more Demands (POST /receipts/:id/allocate)
 */
const allocateExistingReceipt = async ({
    companyId,
    receiptId,
    allocations = [], // [{ demandId, amount }]
    user = null
}) => {
    const receipt = await TransportReceipt.findOne({ _id: receiptId, company: companyId });
    if (!receipt) {
        const err = new Error('Receipt not found');
        err.statusCode = 404;
        throw err;
    }

    let availAdvance = roundMoney(receipt.unallocatedAdvance);
    if (availAdvance <= 0) {
        const err = new Error('Receipt has no unallocated advance balance remaining');
        err.statusCode = 400;
        throw err;
    }

    const createdAllocations = [];
    for (const item of allocations) {
        if (availAdvance <= 0) break;
        const demand = await TransportDemand.findOne({
            _id: item.demandId,
            company: companyId,
            student: receipt.student,
            status: { $in: ['Pending', 'Partial'] }
        });
        if (!demand || demand.outstandingAmount <= 0) continue;

        const reqAmt = item.amount ? roundMoney(item.amount) : roundMoney(demand.outstandingAmount);
        const allocAmt = Math.min(availAdvance, reqAmt, roundMoney(demand.outstandingAmount));
        if (allocAmt <= 0) continue;

        const allocDoc = await ReceiptAllocation.create({
            company: companyId,
            receipt: receipt._id,
            demand: demand._id,
            student: receipt.student,
            allocatedAmount: allocAmt,
            allocatedBy: user?._id || null
        });
        createdAllocations.push(allocDoc);

        demand.allocatedAmount = addMoney(demand.allocatedAmount, allocAmt);
        demand.outstandingAmount = Math.max(0, subMoney(demand.netAmount, demand.allocatedAmount));
        demand.status = demand.outstandingAmount <= 0 ? 'Paid' : 'Partial';
        await demand.save();
        await syncLegacyFeeRecord(demand);

        availAdvance = subMoney(availAdvance, allocAmt);
    }

    receipt.allocatedAmount = subMoney(subMoney(receipt.amount, receipt.refundedAmount || 0), availAdvance);
    receipt.unallocatedAdvance = availAdvance;
    receipt.status = availAdvance <= 0 ? 'FullyAllocated' : 'PartiallyAllocated';
    await receipt.save();

    return { receipt, allocations: createdAllocations };
};

/**
 * Issue a Refund against excess advance or student withdrawal (Section 5 & Section 24)
 */
const issueTransportRefund = async ({
    companyId,
    studentId,
    receiptId = null,
    amount,
    paymentMode = 'Bank Transfer',
    referenceNo = '',
    reason,
    user = null
}) => {
    const refundAmt = roundMoney(amount);
    if (refundAmt <= 0) {
        const err = new Error('Refund amount must be greater than 0');
        err.statusCode = 400;
        throw err;
    }
    if (!reason || !String(reason).trim()) {
        const err = new Error('Reason is required for issuing a refund');
        err.statusCode = 400;
        throw err;
    }

    let receipt = null;
    if (receiptId) {
        receipt = await TransportReceipt.findOne({ _id: receiptId, company: companyId, student: studentId });
    } else {
        receipt = await TransportReceipt.findOne({
            company: companyId,
            student: studentId,
            unallocatedAdvance: { $gte: refundAmt }
        }).sort({ receiptDate: -1 });
    }

    if (receipt) {
        if (roundMoney(receipt.unallocatedAdvance) < refundAmt) {
            const err = new Error(`Refund amount (${refundAmt}) exceeds receipt unallocated advance (${receipt.unallocatedAdvance})`);
            err.statusCode = 400;
            throw err;
        }
        receipt.unallocatedAdvance = subMoney(receipt.unallocatedAdvance, refundAmt);
        receipt.refundedAmount = addMoney(receipt.refundedAmount || 0, refundAmt);
        if (receipt.unallocatedAdvance <= 0 && receipt.allocatedAmount <= 0) {
            receipt.status = 'Refunded';
        }
        await receipt.save();
    }

    const now = new Date();
    const p = parsePeriod(null, now.getMonth() + 1, now.getFullYear());

    const ledgerEntry = await TransportLedgerEntry.create({
        company: companyId,
        student: studentId,
        entryDate: now,
        periodKey: p.periodKey,
        entryType: 'Refund',
        referenceType: 'TransportReceipt',
        referenceId: receipt?._id || null,
        referenceNo: referenceNo || receipt?.receiptNo || 'REFUND',
        description: `Transport Fee Refund via ${paymentMode}: ${reason}`,
        debit: refundAmt, // Reduces credit / increases balance back toward zero
        credit: 0,
        runningBalance: 0,
        reason,
        actor: user?._id || null
    });

    const runningBalance = await recomputeStudentRunningBalance(companyId, studentId);

    await logAudit({
        company: companyId,
        user,
        action: 'TRANSPORT_REFUND_ISSUED',
        entityType: 'TransportReceipt',
        entityId: receipt?._id || studentId,
        afterState: { refundAmount: refundAmt, runningBalance, referenceNo },
        reason
    });

    return { receipt, ledgerEntry, runningBalance };
};

/**
 * Get Complete Student Transport Sub-Ledger & Summary (GET /student-ledger/:id)
 */
const getStudentTransportLedger = async (companyId, studentId) => {
    await ensureBaselineAssignments(companyId);

    const [student, subscriptions, assignments, demands, receipts, allocations, ledgerEntries] = await Promise.all([
        Student.findOne({ _id: studentId, company: companyId })
            .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats')
            .populate('assignedRoute', 'name code shift plannedKm plannedMinutes')
            .populate('activeFeePlan')
            .lean(),
        StudentFeeSubscription.find({ company: companyId, student: studentId })
            .populate('feePlan', 'code name frequency amount')
            .populate('bus', 'carNumber displayCode')
            .populate('route', 'name code')
            .sort({ effectiveFrom: -1 })
            .lean(),
        TransportAssignment.find({ company: companyId, student: studentId })
            .populate('bus', 'carNumber displayCode seatingCapacity reservedSeats')
            .populate('route', 'name code shift')
            .sort({ effectiveFrom: -1 })
            .lean(),
        TransportDemand.find({ company: companyId, student: studentId, status: { $nin: ['Cancelled', 'Reversed'] } })
            .populate('attributedBus', 'carNumber displayCode')
            .populate('attributedRoute', 'name code')
            .sort({ periodKey: -1, createdAt: -1 }),
        TransportReceipt.find({ company: companyId, student: studentId, status: { $ne: 'Reversed' } })
            .sort({ receiptDate: -1 }),
        ReceiptAllocation.find({ company: companyId, student: studentId, isReversed: false })
            .populate('receipt', 'receiptNo receiptDate paymentMode')
            .populate('demand', 'demandNo periodKey month year')
            .lean(),
        TransportLedgerEntry.find({ company: companyId, student: studentId })
            .sort({ entryDate: 1, createdAt: 1 })
    ]);

    if (!student) {
        const err = new Error('Student not found');
        err.statusCode = 404;
        throw err;
    }

    const totalBilled = demands.reduce((acc, d) => addMoney(acc, d.netAmount), 0);
    const totalCollected = receipts.reduce((acc, r) => addMoney(acc, subMoney(r.amount, r.refundedAmount || 0)), 0);
    const totalOutstanding = demands.reduce((acc, d) => addMoney(acc, d.outstandingAmount), 0);
    const totalAdvance = receipts.reduce((acc, r) => addMoney(acc, r.unallocatedAdvance), 0);
    const netBalance = subMoney(totalOutstanding, totalAdvance);

    const formattedEntries = ledgerEntries.map(l => {
        const obj = l.toJSON();
        return {
            ...obj,
            direction: Number(obj.debit) > 0 ? 'DEBIT' : 'CREDIT',
            amount: Number(obj.debit) > 0 ? Number(obj.debit) : Number(obj.credit)
        };
    });

    return {
        student,
        summary: {
            totalBilled,
            totalCollected,
            totalOutstanding,
            totalAdvance,
            advanceBalance: totalAdvance,
            netBalance,
            currentRunningBalance: netBalance
        },
        subscriptions,
        assignments,
        demands: demands.map(d => d.toJSON()),
        receipts: receipts.map(r => r.toJSON()),
        allocations,
        ledgerEntries: formattedEntries,
        entries: formattedEntries
    };
};

/**
 * Get Collections & Receivables Overview with Aging Buckets (Section 5.1)
 */
const getCollectionsOverview = async (companyId, { period, month, year, search = '', routeId = '', busId = '' } = {}) => {
    await ensureBaselineAssignments(companyId);
    const p = parsePeriod(period, month, year);

    const [periodDemands, allOpenDemands, periodReceipts, allAdvanceReceipts, allStudents] = await Promise.all([
        TransportDemand.find({
            company: companyId,
            periodKey: p.periodKey,
            status: { $nin: ['Cancelled', 'Reversed'] }
        })
            .populate('student', 'name className batch contactNumber parentName rollNumber')
            .populate('attributedBus', 'carNumber displayCode')
            .populate('attributedRoute', 'name code'),
        TransportDemand.find({
            company: companyId,
            status: { $in: ['Pending', 'Partial'] },
            outstandingAmount: { $gt: 0 }
        })
            .populate('student', 'name className batch contactNumber parentName rollNumber')
            .populate('attributedBus', 'carNumber displayCode')
            .populate('attributedRoute', 'name code')
            .sort({ dueDate: 1 }),
        TransportReceipt.find({
            company: companyId,
            periodKey: p.periodKey,
            status: { $ne: 'Reversed' }
        })
            .populate('student', 'name className batch contactNumber parentName rollNumber')
            .sort({ receiptDate: -1 }),
        TransportReceipt.find({
            company: companyId,
            unallocatedAdvance: { $gt: 0 },
            status: { $ne: 'Reversed' }
        }),
        Student.find({ company: companyId, status: { $ne: 'inactive' } })
            .populate('assignedBus', 'carNumber displayCode')
            .populate('assignedRoute', 'name code')
            .lean()
    ]);

    const billedThisPeriod = periodDemands.reduce((s, d) => addMoney(s, d.netAmount), 0);
    const collectedThisPeriod = periodReceipts.reduce((s, r) => addMoney(s, subMoney(r.amount, r.refundedAmount || 0)), 0);
    const totalOutstanding = allOpenDemands.reduce((s, d) => addMoney(s, d.outstandingAmount), 0);
    const advanceBalance = allAdvanceReceipts.reduce((s, r) => addMoney(s, r.unallocatedAdvance), 0);

    // Aging calculation
    const now = new Date();
    const agingBucketDetails = {
        current: { label: 'Current (Not Due)', amount: 0, count: 0 },
        days1_30: { label: '1 - 30 Days Overdue', amount: 0, count: 0 },
        days31_60: { label: '31 - 60 Days Overdue', amount: 0, count: 0 },
        days61_90: { label: '61 - 90 Days Overdue', amount: 0, count: 0 },
        days90Plus: { label: '90+ Days Overdue', amount: 0, count: 0 }
    };

    const overdueStudentSet = new Set();
    const openDemandsFormatted = [];

    for (const d of allOpenDemands) {
        const stu = d.student;
        if (!stu) continue;
        if (routeId && String(d.attributedRoute?._id || d.attributedRoute) !== String(routeId)) continue;
        if (busId && String(d.attributedBus?._id || d.attributedBus) !== String(busId)) continue;
        if (search) {
            const q = search.toLowerCase();
            const match =
                (stu.name || '').toLowerCase().includes(q) ||
                (stu.className || '').toLowerCase().includes(q) ||
                (stu.contactNumber || '').toLowerCase().includes(q) ||
                (d.demandNo || '').toLowerCase().includes(q);
            if (!match) continue;
        }

        const outAmt = roundMoney(d.outstandingAmount);
        const daysOverdue = Math.floor((now.getTime() - new Date(d.dueDate).getTime()) / (1000 * 60 * 60 * 24));

        let bucketKey = 'current';
        if (daysOverdue > 90) bucketKey = 'days90Plus';
        else if (daysOverdue > 60) bucketKey = 'days61_90';
        else if (daysOverdue > 30) bucketKey = 'days31_60';
        else if (daysOverdue >= 1) bucketKey = 'days1_30';

        agingBucketDetails[bucketKey].amount = addMoney(agingBucketDetails[bucketKey].amount, outAmt);
        agingBucketDetails[bucketKey].count += 1;

        if (daysOverdue >= 1) {
            overdueStudentSet.add(String(stu._id));
        }

        const dJson = d.toJSON();
        openDemandsFormatted.push({
            ...dJson,
            studentId: stu._id,
            studentName: stu.name,
            rollNumber: stu.rollNumber,
            grade: stu.className,
            parentContact: stu.contactNumber,
            busNumber: d.attributedBus?.displayCode || d.attributedBus?.carNumber || '—',
            routeName: d.attributedRoute?.name || '—',
            paidAmount: dJson.allocatedAmount,
            balanceAmount: dJson.outstandingAmount,
            daysOverdue: Math.max(0, daysOverdue),
            agingBucket: agingBucketDetails[bucketKey].label
        });
    }

    const agingBuckets = {
        current: agingBucketDetails.current.amount,
        days1_30: agingBucketDetails.days1_30.amount,
        days31_60: agingBucketDetails.days31_60.amount,
        days61_90: agingBucketDetails.days61_90.amount,
        days90Plus: agingBucketDetails.days90Plus.amount
    };

    return {
        periodKey: p.periodKey,
        month: p.monthName,
        year: p.year,
        kpis: {
            billedThisPeriod,
            collectedThisPeriod,
            totalOutstanding,
            advanceBalance,
            totalAdvanceBalance: advanceBalance,
            overdueStudentsCount: overdueStudentSet.size,
            overdueStudentCount: overdueStudentSet.size,
            collectionEfficiencyPercent: billedThisPeriod > 0
                ? Number(((collectedThisPeriod / billedThisPeriod) * 100).toFixed(1))
                : 0
        },
        agingBuckets,
        agingBucketDetails,
        periodDemands: periodDemands.map(d => d.toJSON()),
        openDemands: openDemandsFormatted,
        demandDetails: openDemandsFormatted,
        recentReceipts: periodReceipts.map(r => r.toJSON()),
        studentsCount: allStudents.length
    };
};

module.exports = {
    recomputeStudentRunningBalance,
    calculateProration,
    generatePeriodDemands,
    applyDemandAdjustment,
    postTransportReceipt,
    allocateExistingReceipt,
    issueTransportRefund,
    getStudentTransportLedger,
    getCollectionsOverview
};
