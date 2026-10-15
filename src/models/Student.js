const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    className: {
        type: String,
        required: true
    },
    batch: {
        type: String,
        default: null
    },
    rollNumber: {
        type: String
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
    assignedSeatNumber: {
        type: Number,
        default: null
    },
    defaultPickupStop: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Stop', // Wait, we don't have Stop model yet. We can just use String for now or a Route reference.
        default: null
    },
    pickupLocationName: {
        type: String
    },
    pickupLat: {
        type: Number
    },
    pickupLng: {
        type: Number
    },
    contactNumber: {
        type: String
    },
    parentName: {
        type: String
    },
    guardianRelation: {
        type: String,
        default: 'Parent'
    },
    originalAddress: {
        type: String,
        default: ''
    },
    normalizedAddress: {
        type: String,
        default: ''
    },
    geocodeStatus: {
        type: String,
        enum: ['Verified', 'Approximate', 'ManualPin', 'Missing'],
        default: 'Missing'
    },
    assignedRoute: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        default: null
    },
    shift: {
        type: String,
        enum: ['Morning', 'Evening', 'Both'],
        default: 'Both'
    },
    tripDirection: {
        type: String,
        enum: ['Two-Way', 'Pickup-Only', 'Drop-Only'],
        default: 'Two-Way'
    },
    transportStatus: {
        type: String,
        enum: ['Active', 'Suspended', 'Withdrawn', 'Non-Transport'],
        default: 'Active'
    },
    activeFeePlan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FeePlan',
        default: null
    },
    activeSubscription: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StudentFeeSubscription',
        default: null
    },
    activeAssignment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TransportAssignment',
        default: null
    },
    effectiveFrom: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'suspended', 'withdrawn'],
        default: 'active'
    },
    feeAmount: {
        type: Number,
        default: 0
    },
    feeType: {
        type: String,
        enum: ['Monthly', 'Quarterly', 'Term', 'Half-Yearly', 'Yearly', 'Annual'],
        default: 'Monthly'
    },
    financialYear: {
        type: String,
        default: null
    }
}, { timestamps: true });

// Prevent same seat assignment on the same bus
studentSchema.index({ assignedBus: 1, assignedSeatNumber: 1 }, { 
    unique: true, 
    partialFilterExpression: { assignedSeatNumber: { $type: "number" }, assignedBus: { $type: "objectId" } } 
});

module.exports = mongoose.model('Student', studentSchema);
