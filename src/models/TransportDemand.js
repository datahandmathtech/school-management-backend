const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const transportDemandSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    demandNo: {
        type: String,
        required: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    subscription: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StudentFeeSubscription',
        default: null
    },
    feePlan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FeePlan',
        default: null
    },
    attributedBus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null,
        index: true
    },
    attributedRoute: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null,
        index: true
    },
    periodKey: {
        type: String, // e.g. '2026-10'
        required: true,
        index: true
    },
    month: {
        type: String, // e.g. 'October'
        required: true
    },
    year: {
        type: Number, // e.g. 2026
        required: true
    },
    grossAmount: moneyField(0, true),
    discountAmount: moneyField(0),
    discountReason: {
        type: String,
        default: ''
    },
    prorationFactor: {
        type: Number,
        default: 1
    },
    prorationCalculationNote: {
        type: String,
        default: ''
    },
    debitAdjustment: moneyField(0),
    creditAdjustment: moneyField(0),
    taxAmount: moneyField(0),
    netAmount: moneyField(0, true),
    allocatedAmount: moneyField(0),
    outstandingAmount: moneyField(0, true),
    dueDate: {
        type: Date,
        required: true
    },
    isOpeningBalance: {
        type: Boolean,
        default: false
    },
    isPeriodLocked: {
        type: Boolean,
        default: false
    },
    status: {
        type: String,
        enum: ['Pending', 'Partial', 'Paid', 'Cancelled', 'Reversed'],
        default: 'Pending',
        index: true
    },
    cancelReason: {
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

transportDemandSchema.index({ company: 1, demandNo: 1 }, { unique: true });
transportDemandSchema.index({ company: 1, student: 1, periodKey: 1 });

module.exports = mongoose.model('TransportDemand', transportDemandSchema);
