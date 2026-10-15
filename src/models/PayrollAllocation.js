const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const payrollAllocationSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    staffUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    employeeName: {
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['Driver', 'Conductor', 'TransportSupervisor', 'Helper'],
        default: 'Driver'
    },
    periodKey: {
        type: String, // e.g. '2026-10'
        required: true,
        index: true
    },
    fixedPay: moneyField(0, true),
    allowance: moneyField(0),
    overtime: moneyField(0),
    employerCost: moneyField(0),
    deductions: moneyField(0),
    totalGrossCost: moneyField(0, true), // fixedPay + allowance + overtime + employerCost
    netPayable: moneyField(0, true),     // totalGrossCost - deductions
    splits: [{
        bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
        route: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', default: null },
        percentage: { type: Number, default: 100 },
        allocatedAmount: moneyField(0, true)
    }],
    effectiveFrom: {
        type: Date,
        default: Date.now
    },
    effectiveTo: {
        type: Date,
        default: null
    },
    paymentStatus: {
        type: String,
        enum: ['Posted', 'Paid', 'Cancelled'],
        default: 'Posted'
    },
    paymentDate: {
        type: Date,
        default: null
    },
    notes: {
        type: String,
        default: ''
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

payrollAllocationSchema.index({ company: 1, periodKey: 1 });

module.exports = mongoose.model('PayrollAllocation', payrollAllocationSchema);
