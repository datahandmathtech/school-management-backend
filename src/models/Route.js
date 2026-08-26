const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
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
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        expectedTime: { type: String } // e.g. "08:15 AM"
    }],
    shift: {
        type: String,
        enum: ['Morning', 'Evening', 'Both'],
        default: 'Morning'
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Route', routeSchema);
