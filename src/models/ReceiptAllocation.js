const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const receiptAllocationSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    receipt: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TransportReceipt',
        required: true,
        index: true
    },
    demand: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TransportDemand',
        required: true,
        index: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    allocatedAmount: moneyField(0, true),
    allocatedAt: {
        type: Date,
        default: Date.now
    },
    allocatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    isReversed: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

module.exports = mongoose.model('ReceiptAllocation', receiptAllocationSchema);
