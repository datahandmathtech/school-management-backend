const mongoose = require('mongoose');

/**
 * Money & Decimal Precision Utility
 * Enforces integer-paise (cent) arithmetic and Decimal128 storage
 * so currency calculations never use imprecise binary floating-point math.
 */

const toPaise = (val) => {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'object' && val.$numberDecimal) {
        return Math.round(Number(val.$numberDecimal) * 100);
    }
    const str = String(val).replace(/,/g, '').trim();
    const num = Number(str);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100);
};

const fromPaise = (paise) => {
    if (!Number.isFinite(paise)) return 0;
    return Number((Math.round(paise) / 100).toFixed(2));
};

const roundMoney = (val) => fromPaise(toPaise(val));

const addMoney = (...vals) => {
    const totalPaise = vals.reduce((sum, v) => sum + toPaise(v), 0);
    return fromPaise(totalPaise);
};

const subMoney = (a, b) => fromPaise(toPaise(a) - toPaise(b));

const mulMoney = (amount, factor) => {
    const f = Number(factor);
    if (!Number.isFinite(f)) return 0;
    return fromPaise(Math.round(toPaise(amount) * f));
};

const divMoney = (amount, divisor) => {
    const d = Number(divisor);
    if (!Number.isFinite(d) || d === 0) return 0;
    return fromPaise(Math.round(toPaise(amount) / d));
};

/**
 * Mongoose Schema field definition for currency values.
 * Stores as Decimal128 in MongoDB while exposing clean 2-decimal Number in JSON/Object
 * and rounding via integer paise on set.
 */
const moneyField = (defaultValue = 0, required = false) => ({
    type: mongoose.Schema.Types.Decimal128,
    default: () => mongoose.Types.Decimal128.fromString(roundMoney(defaultValue).toFixed(2)),
    required,
    get: (v) => {
        if (v === null || v === undefined) return roundMoney(defaultValue);
        return roundMoney(v.toString());
    },
    set: (v) => {
        const clean = roundMoney(v);
        return mongoose.Types.Decimal128.fromString(clean.toFixed(2));
    }
});

/**
 * Helper to normalize period strings into canonical YYYY-MM and { monthName, monthNum, year }
 */
const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const parsePeriod = (periodInput, monthInput, yearInput) => {
    const now = new Date();
    let year = Number(yearInput) || now.getFullYear();
    let monthNum = now.getMonth() + 1;

    if (periodInput && /^\d{4}-\d{2}$/.test(String(periodInput).trim())) {
        const [y, m] = String(periodInput).trim().split('-').map(Number);
        year = y;
        monthNum = m;
    } else if (monthInput !== undefined && monthInput !== null && monthInput !== '') {
        if (!isNaN(Number(monthInput))) {
            monthNum = Math.min(12, Math.max(1, Number(monthInput)));
        } else {
            const idx = MONTHS.findIndex(m => m.toLowerCase() === String(monthInput).trim().toLowerCase());
            if (idx !== -1) monthNum = idx + 1;
        }
    }

    const periodKey = `${year}-${String(monthNum).padStart(2, '0')}`;
    const monthName = MONTHS[monthNum - 1];
    const startDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    return {
        periodKey,
        year,
        monthNum,
        monthName,
        startDate,
        endDate,
        daysInMonth
    };
};

module.exports = {
    toPaise,
    fromPaise,
    roundMoney,
    addMoney,
    subMoney,
    mulMoney,
    divMoney,
    moneyField,
    MONTHS,
    parsePeriod
};
