const mongoose = require('mongoose');

const transportAssignmentSchema = new mongoose.Schema({
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
    bus: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vehicle',
        required: true,
        index: true
    },
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null,
        index: true
    },
    stop: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Stop',
        default: null
    },
    stopName: {
        type: String,
        default: ''
    },
    pickupLat: {
        type: Number,
        default: null
    },
    pickupLng: {
        type: Number,
        default: null
    },
    pickupTime: {
        type: String,
        default: '07:30 AM'
    },
    seatNumber: {
        type: Number,
        default: null
    },
    shift: {
        type: String,
        enum: ['Morning', 'Evening', 'Both'],
        default: 'Both'
    },
    direction: {
        type: String,
        enum: ['Two-Way', 'Pickup-Only', 'Drop-Only'],
        default: 'Two-Way'
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
    },
    changeReason: {
        type: String,
        default: 'Initial Assignment'
    },
    optimizationRun: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'OptimizationRun',
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, { timestamps: true });

transportAssignmentSchema.index({ company: 1, bus: 1, status: 1, effectiveFrom: 1, effectiveTo: 1 });
transportAssignmentSchema.index({ company: 1, route: 1, status: 1 });
transportAssignmentSchema.index({ student: 1, status: 1, effectiveFrom: -1 });

module.exports = mongoose.model('TransportAssignment', transportAssignmentSchema);
