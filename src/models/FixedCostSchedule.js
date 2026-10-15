const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const fixedCostScheduleSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    bus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        required: true,
        index: true
    },
    costType: {
        type: String,
        enum: [
            'Insurance',
            'Permit',
            'RoadTax',
            'Fitness',
            'Pollution',
            'Lease_EMI',
            'GPS_Subscription',
            'Depreciation',
            'OtherFixed'
        ],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    totalAmount: moneyField(0, true),
    principalComponent: moneyField(0),
    interestComponent: moneyField(0),
    cashPaymentDate: {
        type: Date,
        default: Date.now
    },
    serviceStartDate: {
        type: Date,
        required: true
    },
    serviceEndDate: {
        type: Date,
        required: true
    },
    monthsCovered: {
        type: Number,
        default: 12
    },
    monthlyAmortizedAmount: moneyField(0, true),
    isNonCashDepreciation: {
        type: Boolean,
        default: false
    },
    vendor: {
        type: String,
        default: ''
    },
    policyOrRefNo: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['Active', 'Expired', 'Cancelled'],
        default: 'Active'
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

fixedCostScheduleSchema.index({ company: 1, bus: 1, status: 1 });

module.exports = mongoose.model('FixedCostSchedule', fixedCostScheduleSchema);
