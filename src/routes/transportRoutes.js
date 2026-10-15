const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
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
} = require('../controllers/transportController');

// 1. Dashboard & Fleet Capacity/Financials
router.get('/dashboard', protect, getTransportDashboard);
router.get('/dashboard/:companyId', protect, getTransportDashboard);
router.get('/schools/:companyId/fleet', protect, getSchoolFleet);
router.get('/fleet/:companyId', protect, getSchoolFleetArray);

// 2. Bus Detail & Financials
router.get('/buses/:id', protect, getBusDetail);
router.get('/buses/:id/financials', protect, getBusFinancials);

// 3. Route Detail & Financials
router.get('/routes/:id', protect, getRouteDetail);
router.get('/routes/:id/financials', protect, getRouteFinancials);
router.post('/routes/:routeId/simulate-stop', protect, simulateRouteInsertion);

// 4. Fee Plans & Student Subscriptions (Direct Routes)
router.get('/fee-plans/:companyId', protect, getFeePlans);
router.post('/fee-plans', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createFeePlan);
router.put('/fee-plans/:id', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), updateFeePlan);

router.post('/students/:id/transport-subscription', protect, authorizeRoles('AdmissionOperator', 'TransportManager', 'Finance', 'Admin', 'Executive'), createStudentSubscriptionAndAssignment);
router.post('/students/:id/status', protect, authorizeRoles('AdmissionOperator', 'TransportManager', 'Finance', 'Admin'), updateStudentTransportStatus);
router.get('/students/:id/ledger', protect, getStudentLedger);
router.post('/student-assignments', protect, authorizeRoles('AdmissionOperator', 'TransportManager', 'Finance', 'Admin', 'Executive'), createStudentSubscriptionAndAssignment);

// 5. Billing & Demands (Direct Routes + Invoices Alias)
router.post('/billing/generate', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), generateBilling);
router.post('/invoices/generate', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), generateBilling);
router.get('/demands/:companyId', protect, getDemands);
router.get('/invoices/:companyId', protect, getDemands);
router.post('/demands/opening-balance', protect, authorizeRoles('Finance', 'Admin'), postOpeningBalance);
router.post('/demands/:id/adjust', protect, authorizeRoles('Finance', 'Admin'), adjustDemand);

// 6. Collections, Receipts, Allocations, Refunds & Student Ledger (Direct Routes)
router.get('/collections/:companyId', protect, getCollections);
router.get('/receivables-aging/:companyId', protect, getCollections);
router.get('/receipts/:companyId', protect, getReceipts);
router.post('/receipts', protect, authorizeRoles('Cashier', 'Finance', 'Admin', 'Executive'), createReceipt);
router.post('/receipts/:id/allocate', protect, authorizeRoles('Cashier', 'Finance', 'Admin'), allocateReceipt);
router.post('/refunds', protect, authorizeRoles('Finance', 'Admin'), createRefund);
router.get('/student-ledger/:id', protect, getStudentLedger);

// 7. Expenses, Payroll Allocations, Fixed Costs & Odometer (Direct Routes)
router.get('/expenses/:companyId', protect, getExpensesOnly);
router.post('/expenses', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createExpense);
router.put('/expenses/:id/allocate', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), allocateUnallocatedExpense);
router.get('/staff-assignments/:companyId', protect, getPayrollOnly);
router.post('/staff-assignments', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createPayrollAllocation);
router.post('/payroll-allocations', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createPayrollAllocation);
router.post('/fixed-costs', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createFixedCostSchedule);
router.post('/odometer-logs', protect, authorizeRoles('TransportManager', 'Admin', 'Driver'), createOdometerLog);

// 8. Geocoding, Route Search, Financially Aware Recommendations & Simulation (Direct Routes)
router.post('/geocode', protect, geocodeEndpoint);
router.get('/autocomplete', protect, autocompleteEndpoint);
router.post('/route-search', protect, routeSearchAndRecommend);
router.post('/route-recommendations', protect, routeSearchAndRecommend);
router.post('/route-simulate', protect, simulateRouteInsertion);

// 9. Profitability & Management Intelligence (Direct Routes)
router.get('/reports/transport-profitability', protect, getProfitabilityReport);
router.get('/reports/:companyId/:reportType', protect, getStandardTransportReport);
router.get('/profitability/:companyId', protect, getProfitabilityReport);

// 10. Settings, Onboarding Validation, Period Locks & Audit Logs (Direct Routes)
router.get('/settings/:companyId', protect, getTransportSettingsAndValidation);
router.put('/settings/:companyId', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), updateTransportSettings);
router.get('/period-locks/:companyId', protect, getPeriodLocks);
router.post('/period-locks/:action', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), togglePeriodLock);
router.post('/onboarding/sync-baseline/:companyId', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), syncBaselineStructure);
router.get('/audit-logs/:companyId', protect, getAuditLogsOnly);

// ============================================================================
// 11. Scoped /:companyId/* Route Aliases (Used by Frontend Modules & AC Tests)
// ============================================================================
router.get('/:companyId/dashboard', protect, getTransportDashboard);
router.get('/:companyId/fleet', protect, getSchoolFleetArray);
router.get('/:companyId/fleet/:id', protect, getBusDetail);

router.get('/:companyId/fee-plans', protect, getFeePlans);
router.post('/:companyId/fee-plans', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createFeePlan);
router.put('/:companyId/fee-plans/:id', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), updateFeePlan);

router.get('/:companyId/subscriptions', protect, getSubscriptions);
router.post('/:companyId/subscriptions', protect, authorizeRoles('AdmissionOperator', 'TransportManager', 'Finance', 'Admin', 'Executive'), createStudentSubscriptionAndAssignment);

router.get('/:companyId/assignments', protect, getAssignments);
router.post('/:companyId/assignments/confirm', protect, authorizeRoles('AdmissionOperator', 'TransportManager', 'Finance', 'Admin', 'Executive'), createStudentSubscriptionAndAssignment);

router.get('/:companyId/demands', protect, getDemands);
router.post('/:companyId/demands/generate', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), generateBilling);
router.post('/:companyId/demands/:demandId/adjust', protect, authorizeRoles('Finance', 'Admin'), adjustDemand);
router.post('/:companyId/opening-balances', protect, authorizeRoles('Finance', 'Admin'), postOpeningBalance);

router.get('/:companyId/collections/summary', protect, getCollections);
router.get('/:companyId/receipts', protect, getReceipts);
router.post('/:companyId/receipts', protect, authorizeRoles('Cashier', 'Finance', 'Admin', 'Executive'), createReceipt);
router.post('/:companyId/refunds', protect, authorizeRoles('Finance', 'Admin'), createRefund);
router.get('/:companyId/students/:studentId/ledger', protect, getStudentLedger);

router.get('/:companyId/expenses', protect, getExpensesOnly);
router.post('/:companyId/expenses', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createExpense);
router.put('/:companyId/expenses/:expenseId/allocate', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), allocateUnallocatedExpense);

router.get('/:companyId/payroll', protect, getPayrollOnly);
router.post('/:companyId/payroll', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createPayrollAllocation);

router.get('/:companyId/fixed-schedules', protect, getFixedSchedulesOnly);
router.post('/:companyId/fixed-schedules', protect, authorizeRoles('Finance', 'TransportManager', 'Admin'), createFixedCostSchedule);

router.post('/:companyId/geocode', protect, geocodeEndpoint);
router.post('/:companyId/optimizer/recommend', protect, routeSearchAndRecommend);
router.get('/:companyId/optimizer/runs', protect, getOptimizationRunsOnly);

router.get('/:companyId/profitability', protect, getProfitabilityReport);
router.get('/:companyId/reports/:reportType', protect, getStandardTransportReport);
router.get('/:companyId/baseline-check', protect, getTransportSettingsAndValidation);
router.put('/:companyId/settings', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), updateTransportSettings);
router.get('/:companyId/period-locks', protect, getPeriodLocks);
router.post('/:companyId/period-locks/:action', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), togglePeriodLock);
router.post('/:companyId/onboarding/sync-baseline', protect, authorizeRoles('TransportManager', 'Finance', 'Admin'), syncBaselineStructure);
router.get('/:companyId/audit-logs', protect, getAuditLogsOnly);

module.exports = router;


