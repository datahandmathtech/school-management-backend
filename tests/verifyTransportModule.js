const axios = require('axios');

const BASE_URL = 'http://localhost:5006';

async function runVerification() {
    console.log('====================================================================');
    console.log('LOGKARO SCHOOL FLEET FINANCIAL, CAPACITY & ROUTE INTELLIGENCE v2.0');
    console.log('END-TO-END ACCEPTANCE CRITERIA VERIFICATION (AC-01 TO AC-20)');
    console.log('====================================================================\n');

    // 1. Authenticate as Admin
    const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, {
        mobile: 'admin_user_1',
        password: '@2526Bigday'
    });
    const token = loginRes.data.token;
    const headers = { Authorization: `Bearer ${token}` };

    // Get primary school company
    const compRes = await axios.get(`${BASE_URL}/api/auth/companies`, { headers });
    const company = compRes.data.find(c => c.name === 'PrimaryFleet') || compRes.data[0];
    const cid = company._id;
    console.log(`[PASS] Authenticated & resolved School Tenant: ${company.name} (${cid})`);

    const results = [];
    const assertAC = (code, description, condition, detail = '') => {
        if (!condition) {
            console.error(`❌ [${code}] FAILED: ${description} — ${detail}`);
            process.exitCode = 1;
        } else {
            console.log(`✅ [${code}] PASSED: ${description} ${detail ? `(${detail})` : ''}`);
        }
        results.push({ code, description, passed: !!condition, detail });
    };

    // 2. Check Baseline Readiness (AC-16)
    const baseRes = await axios.get(`${BASE_URL}/api/transport/${cid}/baseline-check`, { headers });
    assertAC(
        'AC-16',
        'Section 11 Existing Fleet/Route/Student Baseline Validator',
        baseRes.data.allPassed === true && baseRes.data.checks.length === 5,
        `${baseRes.data.checks.filter(c => c.passed).length}/5 checks passed`
    );

    // 3. Check Computed Capacity on Fleet (AC-02)
    const fleetRes = await axios.get(`${BASE_URL}/api/transport/${cid}/fleet`, { headers });
    const buses = fleetRes.data;
    const bus01 = buses.find(b => b.busNumber === 'BUS-01');
    const bus02 = buses.find(b => b.busNumber === 'BUS-02');
    const bus03 = buses.find(b => b.busNumber === 'BUS-03');
    assertAC(
        'AC-02',
        'Computed Seating Capacity (Usable = Total - Reserved, Available = Usable - Occupied)',
        bus01 && bus01.capacity.usableCapacity === bus01.capacity.totalSeats - bus01.capacity.reservedStaffSeats &&
        bus03 && bus03.capacity.availableSeats === 0 && bus03.capacity.capacityStatus === 'Full',
        `BUS-01: ${bus01?.capacity.occupiedSeats}/${bus01?.capacity.usableCapacity} (${bus01?.capacity.availableSeats} free), BUS-03: ${bus03?.capacity.occupiedSeats}/${bus03?.capacity.usableCapacity} (${bus03?.capacity.capacityStatus})`
    );

    // 4. Check Fee Plans & Subscriptions (AC-03)
    const plansRes = await axios.get(`${BASE_URL}/api/transport/${cid}/fee-plans`, { headers });
    const subsRes = await axios.get(`${BASE_URL}/api/transport/${cid}/subscriptions`, { headers });
    assertAC(
        'AC-03',
        'Fee Plan Master & Effective-Dated Student Subscriptions',
        plansRes.data.length >= 3 && subsRes.data.length >= 35,
        `${plansRes.data.length} fee plans, ${subsRes.data.length} active subscriptions`
    );

    // 5. Check Period Demands & Proration (AC-04) & Adjustments/Waivers (AC-05)
    const demandsRes = await axios.get(`${BASE_URL}/api/transport/${cid}/demands?periodKey=2026-10`, { headers });
    const proratedDemand = demandsRes.data.find(d => d.isProrated);
    const waivedDemand = demandsRes.data.find(d => Number(d.waiverAmount) > 0);
    assertAC(
        'AC-04',
        'Periodic Demand Generation & Mid-Month Proration Calculation',
        demandsRes.data.length >= 35 && !!proratedDemand,
        `${demandsRes.data.length} demands in 2026-10; Prorated sample: ${proratedDemand?.prorationNote}`
    );
    assertAC(
        'AC-05',
        'Waivers & Credit Adjustments Preserving Original Base Fee',
        !!waivedDemand && Number(waivedDemand.baseAmount) > Number(waivedDemand.netAmount),
        `Demand ${waivedDemand?.demandNo}: Base ₹${waivedDemand?.baseAmount}, Waiver ₹${waivedDemand?.waiverAmount}, Net ₹${waivedDemand?.netAmount}`
    );

    // 6. Check Collections, Partial/FIFO Allocation, Advance Credit & Idempotency (AC-06, AC-07, AC-08)
    const collRes = await axios.get(`${BASE_URL}/api/transport/${cid}/collections/summary?periodKey=2026-10`, { headers });
    const kpis = collRes.data.kpis;
    assertAC(
        'AC-06',
        'Receipts Register with FIFO Allocation & Unallocated Student Advance Credit',
        Number(kpis.collectedThisPeriod) > 0 && Number(kpis.totalAdvanceBalance) > 0,
        `Collected: ₹${kpis.collectedThisPeriod}, Advance Credit: ₹${kpis.totalAdvanceBalance}`
    );

    const sampleStudentId = demandsRes.data[0].student._id;
    const ledgerRes = await axios.get(`${BASE_URL}/api/transport/${cid}/students/${sampleStudentId}/ledger`, { headers });
    assertAC(
        'AC-07',
        'Student Transport Sub-Ledger Chronological Audit & Running Balance',
        ledgerRes.data.entries.length > 0 && typeof ledgerRes.data.summary.currentRunningBalance === 'number',
        `${ledgerRes.data.entries.length} ledger entries for ${demandsRes.data[0].student.name}`
    );

    const aging = collRes.data.agingBuckets;
    const agingSum = aging.current + aging.days1_30 + aging.days31_60 + aging.days61_90 + aging.days90Plus;
    assertAC(
        'AC-08',
        'Receivables Aging Buckets Reconciled with Total Outstanding',
        Math.abs(agingSum - kpis.totalOutstanding) < 1,
        `Total Outstanding: ₹${kpis.totalOutstanding}, Aging Buckets Sum: ₹${agingSum}`
    );

    // 7. Check Cost Engine: Fuel/Mileage, Multi-Bus Payroll Split, Capital vs Routine Maintenance, Fixed Amortization, Shared & Unallocated Queue (AC-09 to AC-13)
    const bus01Detail = await axios.get(`${BASE_URL}/api/transport/${cid}/fleet/${bus01._id}?periodKey=2026-10`, { headers });
    assertAC(
        'AC-09',
        'Direct Fuel & Odometer Mileage Tracking per Bus',
        bus01Detail.data.fuelLogs.length > 0 && Number(bus01Detail.data.profitability.fuelCost) > 0,
        `BUS-01 Fuel Cost: ₹${bus01Detail.data.profitability.fuelCost}`
    );

    const payrollRes = await axios.get(`${BASE_URL}/api/transport/${cid}/payroll?periodKey=2026-10`, { headers });
    const splitStaff = payrollRes.data.find(p => p.allocations && p.allocations.length > 1);
    assertAC(
        'AC-10',
        'Driver/Conductor Payroll Multi-Bus Percentage Split Allocation',
        !!splitStaff,
        `${splitStaff?.staffName} (${splitStaff?.role}) split across ${splitStaff?.allocations.length} buses`
    );

    const bus02Detail = await axios.get(`${BASE_URL}/api/transport/${cid}/fleet/${bus02._id}?periodKey=2026-10`, { headers });
    assertAC(
        'AC-11',
        'Routine vs Capital Maintenance Separation in Bus Operating P&L',
        Number(bus02Detail.data.profitability.capitalMaintenanceCost) > 0 &&
        Number(bus02Detail.data.profitability.routineMaintenanceCost) !== Number(bus02Detail.data.profitability.capitalMaintenanceCost),
        `BUS-02 Routine Maint: ₹${bus02Detail.data.profitability.routineMaintenanceCost}, Capital Overhaul Excluded: ₹${bus02Detail.data.profitability.capitalMaintenanceCost}`
    );

    const fixedRes = await axios.get(`${BASE_URL}/api/transport/${cid}/fixed-schedules`, { headers });
    assertAC(
        'AC-12',
        'Fixed Cost Monthly Amortization Separated from Cash Payment Date',
        fixedRes.data.length >= 3 && Number(bus01Detail.data.profitability.amortizedFixedCost) > 0,
        `BUS-01 Monthly Amortized Fixed Charge: ₹${bus01Detail.data.profitability.amortizedFixedCost}`
    );

    const expRes = await axios.get(`${BASE_URL}/api/transport/${cid}/expenses?periodKey=2026-10`, { headers });
    const unalloc = expRes.data.filter(e => e.costType === 'Unallocated');
    assertAC(
        'AC-13',
        'Shared Overhead Pro-Rata Allocation & Unallocated Expense Exception Queue',
        Number(bus01Detail.data.profitability.allocatedSharedCost) > 0 && unalloc.length > 0,
        `BUS-01 Shared Cost: ₹${bus01Detail.data.profitability.allocatedSharedCost}, Unallocated Queue Count: ${unalloc.length}`
    );

    // 8. Check Bus & Route Profitability Engine (AC-14, AC-15)
    const profRes = await axios.get(`${BASE_URL}/api/transport/${cid}/profitability?periodKey=2026-10`, { headers });
    const schoolSum = profRes.data.schoolSummary;
    assertAC(
        'AC-14',
        'Strict Separation of Billed Transport Revenue (Accrual) vs Cash Collected',
        schoolSum.billedTransportRevenue !== schoolSum.cashCollected &&
        Math.abs((schoolSum.billedTransportRevenue - schoolSum.totalTransportCost) - schoolSum.netTransportContribution) < 1,
        `Billed: ₹${schoolSum.billedTransportRevenue}, Collected: ₹${schoolSum.cashCollected}, Cost: ₹${schoolSum.totalTransportCost}, Net Contribution: ₹${schoolSum.netTransportContribution}`
    );

    const b1Prof = profRes.data.busStatements.find(b => b.busNumber === 'BUS-01');
    assertAC(
        'AC-15',
        'Break-Even Students & Break-Even Occupancy % Computed per Bus & Route',
        b1Prof && b1Prof.breakEvenStudents > 0 && b1Prof.breakEvenOccupancyPct > 0,
        `BUS-01 Break-Even: ${b1Prof?.breakEvenStudents} students (${b1Prof?.breakEvenOccupancyPct}% occupancy)`
    );

    // 9. Check Financially Aware Route Optimizer (AC-17, AC-18, AC-19)
    // Query near Bani Park / Civil Lines, Jaipur (where BUS-03 operates closely, but BUS-03 is 100% FULL!)
    const optRes = await axios.post(`${BASE_URL}/api/transport/${cid}/optimizer/recommend`, {
        studentName: 'Tanvi Joshi (Admission Inquiry)',
        address: 'Bani Park Collectorate Circle, Jaipur',
        lat: 26.9210,
        lng: 75.7860,
        expectedMonthlyFee: 2100
    }, { headers });

    const candidates = optRes.data.candidates;
    const topRec = optRes.data.topRecommendation;
    const bus03Candidate = candidates.find(c => c.busNumber === 'BUS-03');

    assertAC(
        'AC-17',
        'Hard Constraint Enforcement: Full Bus (BUS-03) Blocked Despite Closest Proximity',
        bus03Candidate && bus03Candidate.eligible === false && topRec && topRec.busNumber !== 'BUS-03',
        `BUS-03 eligible=${bus03Candidate?.eligible} (${bus03Candidate?.rejectionReasons.join('; ')}); Top Ranked Eligible Bus: ${topRec?.busNumber}`
    );

    assertAC(
        'AC-18',
        'Incremental Route Economics (Detour KM, Marginal Cost, Net Monthly Margin Impact)',
        topRec && typeof topRec.detourKmOneWay === 'number' &&
        typeof topRec.incrementalMonthlyRevenue === 'number' &&
        typeof topRec.incrementalMonthlyCost === 'number' &&
        typeof topRec.netMonthlyMarginImpact === 'number',
        `${topRec?.busNumber}: Detour +${topRec?.detourKmOneWay}km, Rev +₹${topRec?.incrementalMonthlyRevenue}, Cost +₹${topRec?.incrementalMonthlyCost}, Net Impact +₹${topRec?.netMonthlyMarginImpact}/mo`
    );

    assertAC(
        'AC-19',
        'Explainable 5-Component Score Breakdown & Recommendation Reasons',
        topRec && topRec.scoreBreakdown &&
        typeof topRec.scoreBreakdown.proximity === 'number' &&
        typeof topRec.scoreBreakdown.detour === 'number' &&
        typeof topRec.scoreBreakdown.seatAvailability === 'number' &&
        typeof topRec.scoreBreakdown.routeProfitability === 'number' &&
        typeof topRec.scoreBreakdown.serviceWindow === 'number' &&
        Array.isArray(topRec.explanationReasons) && topRec.explanationReasons.length > 0,
        `Total Score: ${topRec?.totalScore}/100`
    );

    // 10. Check Effective-Dated Assignment Change & Capacity Update (AC-01, AC-20)
    // Reassign a student from BUS-02 to BUS-01 and verify old assignment is closed (effectiveTo set) and new one is Active
    const bus01BeforeSeats = bus01.capacity.occupiedSeats;
    const studentOnBus02 = subsRes.data.find(s => s.student && String(s.student.assignedBus) === String(bus02._id));
    if (studentOnBus02) {
        const confirmRes = await axios.post(`${BASE_URL}/api/transport/${cid}/assignments/confirm`, {
            studentId: studentOnBus02.student._id,
            busId: bus01._id,
            routeId: bus01.assignedRoute?._id || bus01.assignedRoute || bus01.routeId,
            stopName: 'Civil Lines Circle',
            feePlanId: plansRes.data[0]._id,
            monthlyFee: 2600,
            effectiveFrom: '2026-10-15',
            reason: 'Verification test: parent shifted residence to Civil Lines',
            optimizationRunId: optRes.data.optimizationRunId
        }, { headers });

        const historyRes = await axios.get(
            `${BASE_URL}/api/transport/${cid}/assignments?studentId=${studentOnBus02.student._id}&activeOnly=false`,
            { headers }
        );
        const closedRecords = historyRes.data.filter(a => a.status === 'Closed' && a.effectiveTo);
        const activeRecords = historyRes.data.filter(a => a.status === 'Active');

        assertAC(
            'AC-01',
            'Non-Destructive Effective-Dated Assignment History Preserved on Bus/Route Change',
            closedRecords.length >= 1 && activeRecords.length === 1,
            `Student has ${closedRecords.length} closed historical record(s) and ${activeRecords.length} active record`
        );

        assertAC(
            'AC-20',
            'Transactional Assignment Confirmation Updates Bus Occupied & Available Seats Immediately',
            confirmRes.data.updatedBusCapacity.occupiedSeats === bus01BeforeSeats + 1,
            `BUS-01 Occupied Seats updated ${bus01BeforeSeats} -> ${confirmRes.data.updatedBusCapacity.occupiedSeats}`
        );
    }

    console.log('\n====================================================================');
    const passedCount = results.filter(r => r.passed).length;
    console.log(`VERIFICATION SUMMARY: ${passedCount} / ${results.length} ACCEPTANCE CRITERIA PASSED`);
    console.log('====================================================================');
}

runVerification().catch(err => {
    console.error('Verification fatal error:', err.response?.data || err.message);
    process.exit(1);
});
