const mongoose = require('mongoose');

const odometerLogSchema = new mongoose.Schema({
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
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    date: {
        type: Date,
        required: true,
        default: Date.now
    },
    periodKey: {
        type: String, // e.g. '2026-10'
        required: true,
        index: true
    },
    openingKm: {
        type: Number,
        required: true
    },
    closingKm: {
        type: Number,
        required: true
    },
    actualKm: {
        type: Number,
        required: true
    },
    plannedKm: {
        type: Number,
        default: 0
    },
    source: {
        type: String,
        enum: ['Manual', 'FuelLog', 'Attendance', 'GPS'],
        default: 'Manual'
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
}, { timestamps: true });

odometerLogSchema.index({ company: 1, bus: 1, periodKey: 1 });

module.exports = mongoose.model('OdometerLog', odometerLogSchema);
