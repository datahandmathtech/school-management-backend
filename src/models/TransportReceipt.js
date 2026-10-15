const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const transportReceiptSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    receiptNo: {
        type: String,
        required: true
    },
    idempotencyKey: {
        type: String,
        sparse: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    receiptDate: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },
    periodKey: {
        type: String, // YYYY-MM of receiptDate
        required: true,
        index: true
    },
    amount: moneyField(0, true),
    allocatedAmount: moneyField(0),
    unallocatedAdvance: moneyField(0),
    refundedAmount: moneyField(0),
    paymentMode: {
        type: String,
        enum: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Online Gateway', 'Other'],
        default: 'Cash'
    },
    referenceNo: {
        type: String,
        default: ''
    },
    bankOrCashAccount: {
        type: String,
        default: 'Main Transport Collection A/C'
    },
    notes: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['Posted', 'PartiallyAllocated', 'FullyAllocated', 'Refunded', 'Reversed'],
        default: 'Posted',
        index: true
    },
    collectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    collectorName: {
        type: String,
        default: 'Admin'
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

transportReceiptSchema.index({ company: 1, receiptNo: 1 }, { unique: true });
transportReceiptSchema.index({ company: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('TransportReceipt', transportReceiptSchema);
