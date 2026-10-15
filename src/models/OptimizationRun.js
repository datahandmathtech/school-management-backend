const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const optimizationRunSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        default: null
    },
    studentName: {
        type: String,
        default: ''
    },
    inputAddress: {
        type: String,
        required: true
    },
    normalizedAddress: {
        type: String,
        default: ''
    },
    lat: {
        type: Number,
        required: true
    },
    lng: {
        type: Number,
        required: true
    },
    shift: {
        type: String,
        default: 'Both'
    },
    searchRadiusKm: {
        type: Number,
        default: 5
    },
    weightsUsed: {
        routeProximity: { type: Number, default: 25 },
        detourDistanceEfficiency: { type: Number, default: 20 },
        addedTimeEfficiency: { type: Number, default: 20 },
        capacityHealth: { type: Number, default: 10 },
        incrementalFinancialContribution: { type: Number, default: 25 }
    },
    candidates: [{
        busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
        busCode: String,
        carNumber: String,
        routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
        routeName: String,
        feasible: Boolean,
        rejectionReasons: [String],
        nearestStopName: String,
        insertAfterStopSequence: Number,
        distanceFromRouteKm: Number,
        detourKmPerDay: Number,
        detourMinutesPerDay: Number,
        usableCapacity: Number,
        occupiedSeatsBefore: Number,
        availableSeatsBefore: Number,
        availableSeatsAfter: Number,
        occupancyPercentAfter: Number,
        expectedMonthlyRevenue: moneyField(0),
        incrementalMonthlyCost: moneyField(0),
        incrementalMonthlyContribution: moneyField(0),
        currentRouteContribution: moneyField(0),
        projectedRouteContribution: moneyField(0),
        scoreComponents: {
            proximityScore: Number,
            detourDistanceScore: Number,
            addedTimeScore: Number,
            capacityHealthScore: Number,
            financialContributionScore: Number
        },
        totalScore: Number,
        rank: Number,
        explanationReasons: [String]
    }],
    selectedBus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null
    },
    selectedRoute: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    decisionStatus: {
        type: String,
        enum: ['Evaluated', 'Confirmed', 'Overridden', 'NoMatch'],
        default: 'Evaluated'
    },
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

optimizationRunSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model('OptimizationRun', optimizationRunSchema);
