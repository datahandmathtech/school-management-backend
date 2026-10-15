const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    code: {
        type: String,
        default: null
    },
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    },
    assignedBus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        default: null
    },
    stops: [{
        stopName: { type: String, required: true },
        address: { type: String, default: '' },
         sequence: { type: Number, default: 1 },
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        expectedTime: { type: String }, // e.g. "07:35 AM"
        distanceFromStartKm: { type: Number, default: 0 },
        zoneFeeDefault: { type: Number, default: 0 }
    }],
    shift: {
        type: String,
        enum: ['Morning', 'Evening', 'Both'],
        default: 'Both'
    },
    direction: {
        type: String,
        enum: ['Pickup', 'Drop', 'RoundTrip'],
        default: 'RoundTrip'
    },
    plannedKm: {
        type: Number,
        default: 0
    },
    plannedMinutes: {
        type: Number,
        default: 0
    },
    operatingDaysPerMonth: {
        type: Number,
        default: 22
    },
    geometry: {
        type: [[Number]], // Array of [lat, lng] polyline coordinates
        default: []
    },
    defaultFeeAmount: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Route', routeSchema);
