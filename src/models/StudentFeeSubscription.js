const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const studentFeeSubscriptionSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    feePlan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FeePlan',
        default: null
    },
    assignment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TransportAssignment',
        default: null
    },
    bus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null
    },
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    stopName: {
        type: String,
        default: ''
    },
    tripType: {
        type: String,
        enum: ['Two-Way', 'One-Way'],
        default: 'Two-Way'
    },
    frequency: {
        type: String,
        enum: ['Monthly', 'Quarterly', 'Term', 'Half-Yearly', 'Annual', 'Custom'],
        default: 'Monthly'
    },
    standardAmount: moneyField(0, true),
    overrideAmount: {
        type: mongoose.Schema.Types.Decimal128,
        default: null,
        get: (v) => (v === null || v === undefined ? null : Number(Number(v.toString()).toFixed(2))),
        set: (v) => (v === null || v === undefined || v === '' ? null : mongoose.Types.Decimal128.fromString(Number(v).toFixed(2)))
    },
    discountType: {
        type: String,
        enum: ['None', 'Sibling', 'StaffChild', 'Scholarship', 'ManagementWaiver', 'Custom'],
        default: 'None'
    },
    discountAmount: moneyField(0),
    netPeriodicAmount: moneyField(0, true),
    monthlyEquivalentAmount: moneyField(0, true),
    overrideReason: {
        type: String,
        default: ''
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    effectiveFrom: {
        type: Date,
        required: true,
        default: Date.now
    },
    effectiveTo: {
        type: Date,
        default: null
    },
    status: {
        type: String,
        enum: ['Active', 'Suspended', 'Closed', 'Withdrawn'],
        default: 'Active',
        index: true
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

studentFeeSubscriptionSchema.index({ company: 1, student: 1, status: 1 });

module.exports = mongoose.model('StudentFeeSubscription', studentFeeSubscriptionSchema);
