const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    status: {
        type: String,
        default: 'active'
    },
    vehicleLimit: {
        type: Number,
        default: 10
    },
    website: {
        type: String,
        default: 'www.fleetmanagement.com'
    },
    ownerName: {
        type: String,
        default: 'AUTHORIZED MANAGER'
    },
    logoUrl: {
        type: String,
        default: '/logos/logo.png'
    },
    ownerSignatureUrl: {
        type: String,
        default: '/logos/signature.png'
    },
    whatsappNumber: {
        type: String
    },
    gstRate: {
        type: Number,
        default: 5
    },
    gstNumber: {
        type: String,
        default: ''
    },
    classes: [{
        className: { type: String, required: true },
        batches: [{ type: String }]
    }],
    address: {
        type: String,
        default: 'Main School Campus'
    },
    schoolLat: {
        type: Number,
        default: 26.9124
    },
    schoolLng: {
        type: Number,
        default: 75.7873
    },
    timezone: {
        type: String,
        default: 'Asia/Kolkata'
    },
    academicYear: {
        type: String,
        default: '2026-2027'
    },
    operatingDaysPerMonth: {
        type: Number,
        default: 22
    },
    defaultVariableCostPerKm: {
        type: Number,
        default: 18
    },
    optimizerWeights: {
        routeProximity: { type: Number, default: 25 },
        detourDistanceEfficiency: { type: Number, default: 20 },
        addedTimeEfficiency: { type: Number, default: 20 },
        capacityHealth: { type: Number, default: 10 },
        incrementalFinancialContribution: { type: Number, default: 25 }
    },
    alertThresholds: {
        minOccupancyPercent: { type: Number, default: 60 },
        nearlyFullPercent: { type: Number, default: 90 },
        maxDetourKm: { type: Number, default: 5 },
        maxDetourMinutes: { type: Number, default: 15 },
        mileageDeviationPercent: { type: Number, default: 20 },
        overdueAmountThreshold: { type: Number, default: 5000 }
    },
    baselineConfirmed: {
        type: Boolean,
        default: false
    },
    baselineConfirmedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('Company', companySchema);

