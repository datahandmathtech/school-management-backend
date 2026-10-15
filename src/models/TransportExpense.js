const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const transportExpenseSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    expenseDate: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },
    periodKey: {
        type: String, // e.g. '2026-10'
        required: true,
        index: true
    },
    category: {
        type: String,
        enum: [
            'Fuel',
            'Payroll',
            'Maintenance',
            'Toll_FASTag',
            'Insurance',
            'Permit_Tax_Fitness',
            'Lease_EMI',
            'GPS_Technology',
            'Depreciation',
            'Shared_Overhead',
            'Other'
        ],
        required: true,
        index: true
    },
    costClassification: {
        type: String,
        enum: ['DirectVariable', 'DirectFixed', 'SharedCommon'],
        default: 'DirectVariable'
    },
    amount: moneyField(0, true),
    allocationTargetType: {
        type: String,
        enum: ['Bus', 'Route', 'Shared', 'Unallocated'],
        default: 'Bus',
        index: true
    },
    bus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null,
        index: true
    },
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null,
        index: true
    },
    sharedAllocationMethod: {
        type: String,
        enum: ['ByKm', 'ByBusCount', 'ByStudentCount', 'Equal', 'None'],
        default: 'None'
    },
    vendor: {
        type: String,
        default: ''
    },
    referenceNo: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        default: ''
    },
    isNonCashDepreciation: {
        type: Boolean,
        default: false
    },
    sourceModel: {
        type: String, // e.g. 'Fuel', 'Maintenance', 'PayrollAllocation', 'FixedCostSchedule', 'Manual'
        default: 'Manual'
    },
    sourceId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    attachmentUrl: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['Posted', 'Cancelled'],
        default: 'Posted'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

transportExpenseSchema.index({ company: 1, periodKey: 1, category: 1 });
transportExpenseSchema.index({ company: 1, bus: 1, periodKey: 1 });

module.exports = mongoose.model('TransportExpense', transportExpenseSchema);
