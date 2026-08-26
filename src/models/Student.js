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
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    feeAmount: {
        type: Number,
        default: 0
    },
    feeType: {
        type: String,
        enum: ['Monthly', 'Half-Yearly', 'Yearly'],
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
