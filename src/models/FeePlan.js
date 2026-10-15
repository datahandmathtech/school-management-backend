const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const feePlanSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    code: {
        type: String,
        required: true,
        trim: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    basis: {
        type: String,
        enum: ['Route', 'Stop', 'Zone', 'DistanceBand', 'VehicleCategory', 'FixedCustom'],
        default: 'Route'
    },
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    zoneOrBandName: {
        type: String,
        default: ''
    },
    minDistanceKm: {
        type: Number,
        default: 0
    },
    maxDistanceKm: {
        type: Number,
        default: 50
    },
    frequency: {
        type: String,
        enum: ['Monthly', 'Quarterly', 'Term', 'Half-Yearly', 'Annual', 'Custom'],
        default: 'Monthly'
    },
    amount: moneyField(0, true),
    oneWayAmount: moneyField(0),
    twoWayAmount: moneyField(0),
    effectiveFrom: {
        type: Date,
        required: true,
        default: () => new Date('2026-04-01')
    },
    effectiveTo: {
        type: Date,
        default: null
    },
    prorationRule: {
        type: String,
        enum: ['FullMonth', 'DailyProrata', 'HalfMonthThreshold'],
        default: 'DailyProrata'
    },
    taxPercent: {
        type: Number,
        default: 0
    },
    lateFeeAmount: moneyField(0),
    dueDayOfMonth: {
        type: Number,
        default: 10
    },
    discountRules: [{
        name: { type: String, required: true }, // e.g. 'Sibling 10%', 'Staff Child 50%', 'Scholarship'
        type: { type: String, enum: ['Percentage', 'Flat'], default: 'Percentage' },
        value: { type: Number, default: 0 }
    }],
    status: {
        type: String,
        enum: ['Active', 'Archived'],
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

feePlanSchema.index({ company: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('FeePlan', feePlanSchema);
