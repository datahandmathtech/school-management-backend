const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const stopSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    route: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Route',
        required: true,
        index: true
    },
    sequence: {
        type: Number,
        required: true,
        default: 1
    },
    name: {
        type: String,
        required: true
    },
    address: {
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
    plannedTime: {
        type: String,
        default: '07:30 AM'
    },
    distanceFromStartKm: {
        type: Number,
        default: 0
    },
    zoneFeeDefault: moneyField(0),
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

stopSchema.index({ route: 1, sequence: 1 });

module.exports = mongoose.model('Stop', stopSchema);
