const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

const Company = require('../src/models/Company');
const Vehicle = require('../src/models/Vehicle');
const Route = require('../src/models/Route');
const Stop = require('../src/models/Stop');
const Student = require('../src/models/Student');
const TransportAssignment = require('../src/models/TransportAssignment');
const FeePlan = require('../src/models/FeePlan');
const StudentFeeSubscription = require('../src/models/StudentFeeSubscription');
const TransportDemand = require('../src/models/TransportDemand');
const TransportReceipt = require('../src/models/TransportReceipt');
const TransportExpense = require('../src/models/TransportExpense');
const PayrollAllocation = require('../src/models/PayrollAllocation');
const FixedCostSchedule = require('../src/models/FixedCostSchedule');
const OdometerLog = require('../src/models/OdometerLog');
const OptimizationRun = require('../src/models/OptimizationRun');
const Fuel = require('../src/models/Fuel');
const Maintenance = require('../src/models/Maintenance');
const User = require('../src/models/User');

const { confirmStudentTransportAssignment } = require('../src/services/capacityService');
const { generatePeriodDemands, postTransportReceipt, applyDemandAdjustment } = require('../src/services/financeEngineService');
const { evaluateRouteRecommendations } = require('../src/services/routeOptimizerService');
const { calculateRouteGeometry } = require('../src/services/mapProviderService');

const seedTransportData = async (targetCompanyId = null) => {
    try {
        let company = targetCompanyId
            ? await Company.findById(targetCompanyId)
            : await Company.findOne({ name: 'PrimaryFleet' }) || await Company.findOne({});

        if (!company) {
            company = await Company.create({
                name: 'PrimaryFleet',
                address: 'St. Xavier School Campus, C-Scheme, Jaipur',
                schoolLat: 26.9124,
                schoolLng: 75.7873,
                timezone: 'Asia/Kolkata',
                academicYear: '2026-2027',
                operatingDaysPerMonth: 22,
                defaultVariableCostPerKm: 18
            });
        } else {
            company.address = company.address || 'St. Xavier School Campus, C-Scheme, Jaipur';
            company.schoolLat = company.schoolLat || 26.9124;
            company.schoolLng = company.schoolLng || 75.7873;
            company.academicYear = '2026-2027';
            company.operatingDaysPerMonth = 22;
            company.baselineConfirmed = true;
            company.baselineConfirmedAt = new Date();
            await company.save();
        }

        const companyId = company._id;

        // Check if full baseline student assignments & expenses already exist for this company
        const existingAssignments = await TransportAssignment.countDocuments({ company: companyId, status: 'Active' });
        const existingExpenses = await TransportExpense.countDocuments({ company: companyId });
        if (existingAssignments >= 35 && existingExpenses >= 2 && !process.env.FORCE_TRANSPORT_SEED) {
            console.log('Transport module baseline data already present.');
            return { companyId, skipped: true };
        }

        console.log('Seeding School Fleet Financial, Capacity & Route Intelligence baseline data...');

        // 1. Ensure Drivers & Conductors
        const driverSpecs = [
            { name: 'Rameshwar Singh', mobile: '9829011001', username: 'driver_bus01', role: 'Driver', salary: 18500, licenseNumber: 'RJ14-2018004512' },
            { name: 'Mahendra Gurjar', mobile: '9829011002', username: 'driver_bus02', role: 'Driver', salary: 19000, licenseNumber: 'RJ14-2017008911' },
            { name: 'Suresh Meena', mobile: '9829011003', username: 'driver_bus03', role: 'Driver', salary: 17500, licenseNumber: 'RJ14-2019003214' },
            { name: 'Kailash Sharma', mobile: '9829011004', username: 'conductor_01', role: 'Conductor', salary: 11000 }
        ];

        const staffDocs = [];
        for (const d of driverSpecs) {
            let u = await User.findOne({ mobile: d.mobile });
            if (!u) {
                u = await User.create({ ...d, company: companyId, password: 'password123' });
            }
            staffDocs.push(u);
        }

        // 2. Ensure 3 School Buses with distinct capacities & operational profiles
        // BUS-01: Profitable & Healthy Occupancy (35 seats, 2 reserved = 33 usable)
        // BUS-02: Underutilized / Loss-making (40 seats, 2 reserved = 38 usable, low student count)
        // BUS-03: Full Capacity Mini-Bus (15 seats, 1 reserved = 14 usable, 100% full to test hard capacity constraint!)
        const busSpecs = [
            {
                carNumber: 'RJ-14-PA-4101',
                displayCode: 'BUS-01',
                model: 'Tata Starbus Ultra 35',
                permitType: 'School Bus Permit',
                carType: 'Bus',
                busType: '35-seater',
                seatingCapacity: 35,
                reservedSeats: 2,
                defaultFuelType: 'Diesel',
                currentDriver: staffDocs[0]._id,
                assignedConductor: staffDocs[3]._id,
                lastOdometer: 48250,
                documents: [
                    { documentType: 'INSURANCE', imageUrl: '/logos.png', expiryDate: new Date('2027-05-15') },
                    { documentType: 'FITNESS', imageUrl: '/logos.png', expiryDate: new Date('2027-03-30') },
                    { documentType: 'PERMIT', imageUrl: '/logos.png', expiryDate: new Date('2027-08-20') }
                ]
            },
            {
                carNumber: 'RJ-14-PA-4102',
                displayCode: 'BUS-02',
                model: 'Ashok Leyland Sunshine 40',
                permitType: 'School Bus Permit',
                carType: 'Bus',
                busType: '40-seater',
                seatingCapacity: 40,
                reservedSeats: 2,
                defaultFuelType: 'Diesel',
                currentDriver: staffDocs[1]._id,
                lastOdometer: 61400,
                documents: [
                    { documentType: 'INSURANCE', imageUrl: '/logos.png', expiryDate: new Date('2027-04-10') },
                    { documentType: 'FITNESS', imageUrl: '/logos.png', expiryDate: new Date('2026-11-05') }
                ]
            },
            {
                carNumber: 'RJ-14-PA-4103',
                displayCode: 'BUS-03',
                model: 'Force Traveller School 15',
                permitType: 'School Bus Permit',
                carType: 'Mini Bus',
                busType: '15-seater',
                seatingCapacity: 8, // 8 total, 1 reserved = 7 usable so we can fill it to 7/7 (100% Full)
                reservedSeats: 1,
                defaultFuelType: 'CNG',
                currentDriver: staffDocs[2]._id,
                lastOdometer: 32900,
                documents: [
                    { documentType: 'INSURANCE', imageUrl: '/logos.png', expiryDate: new Date('2027-06-25') }
                ]
            }
        ];

        const busDocs = [];
        for (const bSpec of busSpecs) {
            let b = await Vehicle.findOne({ carNumber: bSpec.carNumber });
            if (!b) {
                b = await Vehicle.create({ ...bSpec, company: companyId, status: 'active' });
            } else {
                Object.assign(b, bSpec, { company: companyId, status: 'active' });
                await b.save();
            }
            busDocs.push(b);
        }

        // 3. Create 3 Routes with ordered stops and calculated geometry
        const schoolCenter = { lat: company.schoolLat || 26.9124, lng: company.schoolLng || 75.7873 };
        const routeSpecs = [
            {
                name: 'Route A - Vaishali & Nirman Nagar Corridor',
                code: 'RT-A01',
                assignedBus: busDocs[0]._id,
                shift: 'Both',
                direction: 'RoundTrip',
                defaultFeeAmount: 2500,
                stops: [
                    { stopName: 'Chitrakoot Stadium, Vaishali Nagar', address: 'Chitrakoot Marg, Vaishali Nagar, Jaipur', sequence: 1, lat: 26.9012, lng: 75.7364, expectedTime: '07:10 AM' },
                    { stopName: 'Amrapali Circle, Vaishali Nagar', address: 'Amrapali Marg, Vaishali Nagar, Jaipur', sequence: 2, lat: 26.9115, lng: 75.7412, expectedTime: '07:18 AM' },
                    { stopName: 'Nirman Nagar, Ajmer Road', address: 'Kings Road, Nirman Nagar, Jaipur', sequence: 3, lat: 26.8868, lng: 75.7521, expectedTime: '07:26 AM' },
                    { stopName: 'Sodala Metro Station', address: 'Ajmer Road, Sodala, Jaipur', sequence: 4, lat: 26.8975, lng: 75.7706, expectedTime: '07:34 AM' },
                    { stopName: 'Civil Lines Circle', address: 'Raj Bhavan Road, Civil Lines, Jaipur', sequence: 5, lat: 26.9048, lng: 75.7824, expectedTime: '07:42 AM' }
                ]
            },
            {
                name: 'Route B - Mansarovar & Tonk Road Express',
                code: 'RT-B02',
                assignedBus: busDocs[1]._id,
                shift: 'Both',
                direction: 'RoundTrip',
                defaultFeeAmount: 2400,
                stops: [
                    { stopName: 'Mansarovar Sector 5', address: 'Madhyam Marg, Mansarovar, Jaipur', sequence: 1, lat: 26.8549, lng: 75.7681, expectedTime: '07:05 AM' },
                    { stopName: 'Gopalpura Bypass, Tonk Road', address: 'Gopalpura Mode, Tonk Road, Jaipur', sequence: 2, lat: 26.8663, lng: 75.7955, expectedTime: '07:18 AM' },
                    { stopName: 'Malviya Nagar WTP', address: 'JLN Marg, Malviya Nagar, Jaipur', sequence: 3, lat: 26.8536, lng: 75.8185, expectedTime: '07:28 AM' },
                    { stopName: 'Raja Park Panchwati Circle', address: 'Gurunanakpura, Raja Park, Jaipur', sequence: 4, lat: 26.8974, lng: 75.8266, expectedTime: '07:40 AM' }
                ]
            },
            {
                name: 'Route C - Bani Park & Vidyadhar Nagar Shuttle',
                code: 'RT-C03',
                assignedBus: busDocs[2]._id,
                shift: 'Both',
                direction: 'RoundTrip',
                defaultFeeAmount: 2100,
                stops: [
                    { stopName: 'Vidyadhar Nagar Sector 2', address: 'Central Spine, Vidyadhar Nagar, Jaipur', sequence: 1, lat: 26.9628, lng: 75.7815, expectedTime: '07:15 AM' },
                    { stopName: 'Jhotwara Flyover', address: 'Kalwar Road, Jhotwara, Jaipur', sequence: 2, lat: 26.9438, lng: 75.7436, expectedTime: '07:25 AM' },
                    { stopName: 'Bani Park Collectorate Circle', address: 'Sawaimadhopur Road, Bani Park, Jaipur', sequence: 3, lat: 26.9293, lng: 75.7885, expectedTime: '07:38 AM' }
                ]
            }
        ];

        const routeDocs = [];
        for (let i = 0; i < routeSpecs.length; i++) {
            const rSpec = routeSpecs[i];
            const geom = calculateRouteGeometry(rSpec.stops, schoolCenter);
            let r = await Route.findOne({ company: companyId, code: rSpec.code }) ||
                await Route.findOne({ company: companyId, name: rSpec.name });
            const payload = {
                ...rSpec,
                company: companyId,
                stops: geom.stopsWithCumulativeKm,
                plannedKm: geom.plannedKm,
                plannedMinutes: geom.plannedMinutes,
                geometry: geom.geometry,
                status: 'active',
                isActive: true
            };
            if (!r) {
                r = await Route.create(payload);
            } else {
                Object.assign(r, payload);
                await r.save();
            }
            await Vehicle.findByIdAndUpdate(busDocs[i]._id, { routeAssigned: r._id });
            await Stop.deleteMany({ route: r._id });
            await Stop.insertMany(
                r.stops.map((s, idx) => ({
                    company: companyId,
                    route: r._id,
                    sequence: idx + 1,
                    name: s.stopName,
                    address: s.address || s.stopName,
                    lat: s.lat,
                    lng: s.lng,
                    plannedTime: s.expectedTime,
                    distanceFromStartKm: s.distanceFromStartKm
                }))
            );
            routeDocs.push(r);
        }
        await Route.deleteMany({ company: companyId, code: { $nin: ['RT-A01', 'RT-B02', 'RT-C03'] } });

        // 4. Create Fee Plans (Route-based, Zone-based, and Annual)
        const feePlanSpecs = [
            {
                code: 'FP-RTA-M',
                name: 'Route A Standard Monthly',
                basis: 'Route',
                route: routeDocs[0]._id,
                frequency: 'Monthly',
                amount: 2600,
                oneWayAmount: 1700,
                twoWayAmount: 2600,
                prorationRule: 'DailyProrata',
                effectiveFrom: new Date('2026-04-01'),
                discountRules: [
                    { name: 'Sibling 10%', type: 'Percentage', value: 10 },
                    { name: 'Staff Child 50%', type: 'Percentage', value: 50 }
                ]
            },
            {
                code: 'FP-RTB-M',
                name: 'Route B South Corridor Monthly',
                basis: 'Route',
                route: routeDocs[1]._id,
                frequency: 'Monthly',
                amount: 2400,
                oneWayAmount: 1600,
                twoWayAmount: 2400,
                prorationRule: 'DailyProrata',
                effectiveFrom: new Date('2026-04-01'),
                discountRules: [{ name: 'Sibling 10%', type: 'Percentage', value: 10 }]
            },
            {
                code: 'FP-RTC-M',
                name: 'Route C North Shuttle Monthly',
                basis: 'Route',
                route: routeDocs[2]._id,
                frequency: 'Monthly',
                amount: 2100,
                oneWayAmount: 1400,
                twoWayAmount: 2100,
                prorationRule: 'DailyProrata',
                effectiveFrom: new Date('2026-04-01')
            },
            {
                code: 'FP-ANNUAL-26',
                name: 'Annual Transport Saver Plan (12M)',
                basis: 'Zone',
                zoneOrBandName: 'City Wide Zone 1-8 KM',
                frequency: 'Annual',
                amount: 27600, // ₹2300/month equivalent
                oneWayAmount: 18000,
                twoWayAmount: 27600,
                prorationRule: 'DailyProrata',
                effectiveFrom: new Date('2026-04-01')
            }
        ];

        const feePlanDocs = [];
        for (const fpSpec of feePlanSpecs) {
            let fp = await FeePlan.findOne({ company: companyId, code: fpSpec.code });
            if (!fp) {
                fp = await FeePlan.create({ ...fpSpec, company: companyId });
            } else {
                Object.assign(fp, fpSpec);
                await fp.save();
            }
            feePlanDocs.push(fp);
        }

        // 5. Create Students across the 3 Buses:
        // - Bus 1 (Route A): 24 students -> ₹2,600 * 24 = ₹62,400/mo revenue (Profitable!)
        // - Bus 2 (Route B): 8 students -> ₹2,400 * 8 = ₹19,200/mo revenue vs ~₹41,000 cost (Underutilized & Loss-making!)
        // - Bus 3 (Route C): 7 students -> 7/7 usable seats occupied (100% FULL! Tests hard capacity block!)
        const routeAStops = routeDocs[0].stops;
        const routeBStops = routeDocs[1].stops;
        const routeCStops = routeDocs[2].stops;

        const firstNames = [
            'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan',
            'Ananya', 'Diya', 'Pari', 'Saanvi', 'Aadhya', 'Kiara', 'Myra', 'Ira', 'Kavya', 'Riya',
            'Dhruv', 'Kabir', 'Rohan', 'Aryan', 'Neha', 'Pooja', 'Tanvi', 'Meera', 'Dev', 'Karan',
            'Harsh', 'Yash', 'Nisha', 'Simran', 'Ritika', 'Pranav', 'Nikhil', 'Siddharth', 'Gauri'
        ];
        const lastNames = ['Sharma', 'Verma', 'Rathore', 'Jain', 'Agarwal', 'Mehta', 'Khandelwal', 'Choudhary', 'Shekhawat', 'Gupta'];
        const classesList = ['Class 5', 'Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10'];

        const existingAssignedCount = await TransportAssignment.countDocuments({ company: companyId, status: 'Active' });
        const createdStudents = [];

        if (existingAssignedCount < 25) {
            // Clear partial seed students to ensure clean seat numbers
            await TransportAssignment.deleteMany({ company: companyId });
            await StudentFeeSubscription.deleteMany({ company: companyId });
            await Student.deleteMany({ company: companyId, rollNumber: /^ST-2026-/ });

            let idxCounter = 0;

            // Enroll 24 students on Bus 1 (Route A)
            for (let i = 0; i < 24; i++) {
                const stop = routeAStops[i % routeAStops.length];
                const fName = firstNames[idxCounter % firstNames.length];
                const lName = lastNames[idxCounter % lastNames.length];
                idxCounter++;

                const stu = await Student.create({
                    name: `${fName} ${lName}`,
                    className: classesList[i % classesList.length],
                    batch: i % 2 === 0 ? 'A' : 'B',
                    rollNumber: `ST-2026-${String(idxCounter).padStart(3, '0')}`,
                    company: companyId,
                    parentName: `Mr. ${lName}`,
                    contactNumber: `98291${String(10000 + idxCounter).slice(-5)}`,
                    pickupLocationName: stop.stopName,
                    originalAddress: `${stop.address || stop.stopName}, Jaipur`,
                    normalizedAddress: `${stop.address || stop.stopName}, Jaipur`,
                    geocodeStatus: 'Verified',
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    feeAmount: 2600,
                    feeType: 'Monthly',
                    financialYear: '2026-2027',
                    effectiveFrom: new Date('2026-04-01')
                });

                await confirmStudentTransportAssignment({
                    companyId,
                    studentId: stu._id,
                    busId: busDocs[0]._id,
                    routeId: routeDocs[0]._id,
                    stopName: stop.stopName,
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    pickupTime: stop.expectedTime,
                    seatNumber: i + 1,
                    shift: 'Both',
                    direction: 'Two-Way',
                    effectiveFrom: new Date('2026-04-01'),
                    feePlanId: feePlanDocs[0]._id,
                    discountType: i === 3 ? 'Sibling' : 'None',
                    discountAmount: i === 3 ? 260 : 0,
                    changeReason: 'Academic Year 2026-27 Onboarding'
                });
                createdStudents.push(stu);
            }

            // Enroll 8 students on Bus 2 (Route B - Underutilized / Loss-making)
            for (let i = 0; i < 8; i++) {
                const stop = routeBStops[i % routeBStops.length];
                const fName = firstNames[idxCounter % firstNames.length];
                const lName = lastNames[idxCounter % lastNames.length];
                idxCounter++;

                // Make the 8th student start mid-month (16th Oct 2026) to showcase Proration!
                const isMidMonthAdmission = i === 7;
                const effDate = isMidMonthAdmission ? new Date('2026-10-16') : new Date('2026-04-01');

                const stu = await Student.create({
                    name: `${fName} ${lName}`,
                    className: classesList[i % classesList.length],
                    batch: 'A',
                    rollNumber: `ST-2026-${String(idxCounter).padStart(3, '0')}`,
                    company: companyId,
                    parentName: `Mrs. ${lName}`,
                    contactNumber: `98292${String(10000 + idxCounter).slice(-5)}`,
                    pickupLocationName: stop.stopName,
                    originalAddress: `${stop.address || stop.stopName}, Jaipur`,
                    normalizedAddress: `${stop.address || stop.stopName}, Jaipur`,
                    geocodeStatus: 'Verified',
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    feeAmount: 2400,
                    feeType: 'Monthly',
                    financialYear: '2026-2027',
                    effectiveFrom: effDate
                });

                await confirmStudentTransportAssignment({
                    companyId,
                    studentId: stu._id,
                    busId: busDocs[1]._id,
                    routeId: routeDocs[1]._id,
                    stopName: stop.stopName,
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    pickupTime: stop.expectedTime,
                    seatNumber: i + 1,
                    shift: 'Both',
                    direction: 'Two-Way',
                    effectiveFrom: effDate,
                    feePlanId: feePlanDocs[1]._id,
                    changeReason: isMidMonthAdmission ? 'Mid-Month Admission (Prorated)' : 'Academic Year 2026-27 Onboarding'
                });
                createdStudents.push(stu);
            }

            // Enroll 7 students on Bus 3 (Route C - 7/7 Usable Capacity = 100% FULL)
            for (let i = 0; i < 7; i++) {
                const stop = routeCStops[i % routeCStops.length];
                const fName = firstNames[idxCounter % firstNames.length];
                const lName = lastNames[idxCounter % lastNames.length];
                idxCounter++;

                const stu = await Student.create({
                    name: `${fName} ${lName}`,
                    className: classesList[i % classesList.length],
                    batch: 'B',
                    rollNumber: `ST-2026-${String(idxCounter).padStart(3, '0')}`,
                    company: companyId,
                    parentName: `Mr. ${lName}`,
                    contactNumber: `98293${String(10000 + idxCounter).slice(-5)}`,
                    pickupLocationName: stop.stopName,
                    originalAddress: `${stop.address || stop.stopName}, Jaipur`,
                    normalizedAddress: `${stop.address || stop.stopName}, Jaipur`,
                    geocodeStatus: 'Verified',
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    feeAmount: 2100,
                    feeType: 'Monthly',
                    financialYear: '2026-2027',
                    effectiveFrom: new Date('2026-04-01')
                });

                await confirmStudentTransportAssignment({
                    companyId,
                    studentId: stu._id,
                    busId: busDocs[2]._id,
                    routeId: routeDocs[2]._id,
                    stopName: stop.stopName,
                    pickupLat: stop.lat,
                    pickupLng: stop.lng,
                    pickupTime: stop.expectedTime,
                    seatNumber: i + 1,
                    shift: 'Both',
                    direction: 'Two-Way',
                    effectiveFrom: new Date('2026-04-01'),
                    feePlanId: feePlanDocs[2]._id,
                    changeReason: 'Academic Year 2026-27 Onboarding'
                });
                createdStudents.push(stu);
            }
        }

        await Student.updateMany(
            { company: companyId, $or: [{ pickupLat: null }, { pickupLng: null }] },
            { $set: { pickupLat: 26.9012, pickupLng: 75.7364, geocodeStatus: 'Verified' } }
        );

        // 6. Generate Billing Demands for September 2026 and October 2026
        await generatePeriodDemands({ companyId, period: '2026-09', applyProration: true });
        const octBilling = await generatePeriodDemands({ companyId, period: '2026-10', applyProration: true });

        // 7. Post Realistic Receipts (Full payments, Partial payments, and Advance credit)
        await TransportReceipt.deleteMany({ company: companyId, idempotencyKey: null });
        const octDemands = await TransportDemand.find({ company: companyId, periodKey: '2026-10' }).limit(26);
        const existingReceipts = await TransportReceipt.countDocuments({ company: companyId });

        if (existingReceipts < 5 && octDemands.length > 0) {
            // Pay first 18 demands in full
            for (let i = 0; i < Math.min(18, octDemands.length); i++) {
                const d = octDemands[i];
                await postTransportReceipt({
                    companyId,
                    studentId: d.student,
                    amount: d.netAmount,
                    receiptDate: new Date('2026-10-08'),
                    paymentMode: i % 2 === 0 ? 'UPI' : 'Bank Transfer',
                    referenceNo: `UTR202610080${i + 1}`,
                    notes: 'October 2026 Transport Fee'
                });
            }

            // Partial payment on 2 demands
            for (let i = 18; i < Math.min(20, octDemands.length); i++) {
                const d = octDemands[i];
                await postTransportReceipt({
                    companyId,
                    studentId: d.student,
                    amount: 1000,
                    receiptDate: new Date('2026-10-10'),
                    paymentMode: 'Cash',
                    referenceNo: `CSH-10${i}`,
                    notes: 'Partial October payment'
                });
            }

            // Advance payment (excess ₹3,000) on 1 student
            if (octDemands[20]) {
                await postTransportReceipt({
                    companyId,
                    studentId: octDemands[20].student,
                    amount: Number(octDemands[20].netAmount) + 3000,
                    receiptDate: new Date('2026-10-11'),
                    paymentMode: 'UPI',
                    referenceNo: 'UPI-ADV-9901',
                    notes: 'October Fee + Advance for Nov/Dec'
                });
            }

            // Apply a Scholarship Waiver on 1 demand
            if (octDemands[21]) {
                await applyDemandAdjustment({
                    companyId,
                    demandId: octDemands[21]._id,
                    adjustmentType: 'Waiver',
                    amount: 500,
                    reason: 'Principal Merit Transport Waiver'
                });
            }
        }

        // 8. Seed Fuel Logs, Payroll Allocations, Maintenance Jobs, Fixed Cost Schedules & Shared Overhead for Oct 2026
        const existingPayroll = await PayrollAllocation.countDocuments({ company: companyId, periodKey: '2026-10' });
        if (existingPayroll === 0) {
            await PayrollAllocation.create([
                {
                    company: companyId,
                    staffUser: staffDocs[0]._id,
                    employeeName: 'Rameshwar Singh (Driver BUS-01)',
                    role: 'Driver',
                    periodKey: '2026-10',
                    fixedPay: 17000,
                    allowance: 1500,
                    overtime: 500,
                    totalGrossCost: 19000,
                    netPayable: 19000,
                    splits: [{ bus: busDocs[0]._id, route: routeDocs[0]._id, percentage: 100, allocatedAmount: 19000 }]
                },
                {
                    company: companyId,
                    staffUser: staffDocs[1]._id,
                    employeeName: 'Mahendra Gurjar (Driver BUS-02)',
                    role: 'Driver',
                    periodKey: '2026-10',
                    fixedPay: 18000,
                    allowance: 1000,
                    overtime: 0,
                    totalGrossCost: 19000,
                    netPayable: 19000,
                    splits: [{ bus: busDocs[1]._id, route: routeDocs[1]._id, percentage: 100, allocatedAmount: 19000 }]
                },
                {
                    company: companyId,
                    staffUser: staffDocs[2]._id,
                    employeeName: 'Suresh Meena (Driver BUS-03)',
                    role: 'Driver',
                    periodKey: '2026-10',
                    fixedPay: 15000,
                    allowance: 1000,
                    overtime: 0,
                    totalGrossCost: 16000,
                    netPayable: 16000,
                    splits: [{ bus: busDocs[2]._id, route: routeDocs[2]._id, percentage: 100, allocatedAmount: 16000 }]
                },
                {
                    // Multi-bus split conductor (50% BUS-01, 50% BUS-02)
                    company: companyId,
                    staffUser: staffDocs[3]._id,
                    employeeName: 'Kailash Sharma (Shared Conductor)',
                    role: 'Conductor',
                    periodKey: '2026-10',
                    fixedPay: 11000,
                    allowance: 1000,
                    overtime: 0,
                    totalGrossCost: 12000,
                    netPayable: 12000,
                    splits: [
                        { bus: busDocs[0]._id, route: routeDocs[0]._id, percentage: 50, allocatedAmount: 6000 },
                        { bus: busDocs[1]._id, route: routeDocs[1]._id, percentage: 50, allocatedAmount: 6000 }
                    ]
                }
            ]);
        }

        const existingFixed = await FixedCostSchedule.countDocuments({ company: companyId });
        if (existingFixed === 0) {
            await FixedCostSchedule.create([
                {
                    company: companyId,
                    bus: busDocs[0]._id,
                    costType: 'Insurance',
                    title: 'ICICI Lombard Comprehensive School Bus Policy',
                    totalAmount: 42000,
                    cashPaymentDate: new Date('2026-04-05'),
                    serviceStartDate: new Date('2026-04-01'),
                    serviceEndDate: new Date('2027-03-31'),
                    monthsCovered: 12,
                    monthlyAmortizedAmount: 3500,
                    vendor: 'ICICI Lombard',
                    policyOrRefNo: 'POL-BUS01-2026'
                },
                {
                    company: companyId,
                    bus: busDocs[1]._id,
                    costType: 'Insurance',
                    title: 'HDFC ERGO Commercial Fleet Insurance',
                    totalAmount: 48000,
                    cashPaymentDate: new Date('2026-04-05'),
                    serviceStartDate: new Date('2026-04-01'),
                    serviceEndDate: new Date('2027-03-31'),
                    monthsCovered: 12,
                    monthlyAmortizedAmount: 4000,
                    vendor: 'HDFC ERGO',
                    policyOrRefNo: 'POL-BUS02-2026'
                },
                {
                    company: companyId,
                    bus: busDocs[2]._id,
                    costType: 'Permit',
                    title: 'State RTA School Transport Permit & Fitness',
                    totalAmount: 18000,
                    cashPaymentDate: new Date('2026-04-10'),
                    serviceStartDate: new Date('2026-04-01'),
                    serviceEndDate: new Date('2027-03-31'),
                    monthsCovered: 12,
                    monthlyAmortizedAmount: 1500,
                    vendor: 'RTO Jaipur',
                    policyOrRefNo: 'RTO-RJ14-4103'
                }
            ]);
        }

        const existingFuelOct = await Fuel.countDocuments({
            company: companyId,
            date: { $gte: new Date('2026-10-01'), $lte: new Date('2026-10-31') }
        });
        if (existingFuelOct === 0) {
            await Fuel.create([
                {
                    vehicle: busDocs[0]._id,
                    route: routeDocs[0]._id,
                    company: companyId,
                    fuelType: 'Diesel',
                    date: new Date('2026-10-07'),
                    amount: 11280,
                    quantity: 120,
                    rate: 94,
                    odometer: 48250,
                    distance: 620,
                    mileage: 5.17,
                    costPerKm: 18.19,
                    stationName: 'HP Highway Petro Vaishali',
                    paymentMode: 'UPI',
                    driver: 'Rameshwar Singh',
                    periodKey: '2026-10'
                },
                {
                    vehicle: busDocs[1]._id,
                    route: routeDocs[1]._id,
                    company: companyId,
                    fuelType: 'Diesel',
                    date: new Date('2026-10-09'),
                    amount: 14100,
                    quantity: 150,
                    rate: 94,
                    odometer: 61400,
                    distance: 540,
                    mileage: 3.6, // Lower mileage to trigger Abnormal Mileage Alert!
                    costPerKm: 26.11,
                    stationName: 'IndianOil Tonk Road',
                    paymentMode: 'Bank Transfer',
                    driver: 'Mahendra Gurjar',
                    periodKey: '2026-10',
                    abnormalMileageFlag: true
                },
                {
                    vehicle: busDocs[2]._id,
                    route: routeDocs[2]._id,
                    company: companyId,
                    fuelType: 'CNG',
                    date: new Date('2026-10-08'),
                    amount: 5400,
                    quantity: 60,
                    rate: 90,
                    odometer: 32900,
                    distance: 480,
                    mileage: 8.0,
                    costPerKm: 11.25,
                    stationName: 'Torrent Gas Vidyadhar Nagar',
                    paymentMode: 'Cash',
                    driver: 'Suresh Meena',
                    periodKey: '2026-10'
                }
            ]);
        }

        const existingMaintOct = await Maintenance.countDocuments({
            company: companyId,
            billDate: { $gte: new Date('2026-10-01'), $lte: new Date('2026-10-31') }
        });
        if (existingMaintOct === 0) {
            await Maintenance.create([
                {
                    vehicle: busDocs[0]._id,
                    company: companyId,
                    maintenanceType: 'Scheduled Service',
                    category: 'Engine Oil & Filter Service',
                    garageName: 'Tata Authorized Workshop',
                    billNumber: 'INV-TATA-882',
                    billDate: new Date('2026-10-06'),
                    amount: 3200,
                    currentKm: 48100,
                    nextServiceKm: 58000,
                    status: 'Completed',
                    periodKey: '2026-10'
                },
                {
                    vehicle: busDocs[1]._id,
                    company: companyId,
                    maintenanceType: 'Repair',
                    category: 'Brake Pad & Suspension Bush Replacement',
                    garageName: 'Leyland Service Hub',
                    billNumber: 'INV-AL-441',
                    billDate: new Date('2026-10-11'),
                    amount: 5800,
                    currentKm: 61200,
                    downtimeDays: 1,
                    isCapitalReplacement: false,
                    status: 'Completed',
                    periodKey: '2026-10'
                },
                {
                    vehicle: busDocs[1]._id,
                    company: companyId,
                    maintenanceType: 'Capital Overhaul',
                    category: 'Major Gearbox & Clutch Assembly Capital Replacement',
                    garageName: 'Leyland Service Hub',
                    billNumber: 'INV-AL-905-CAP',
                    billDate: new Date('2026-10-14'),
                    amount: 28000,
                    currentKm: 61350,
                    downtimeDays: 2,
                    isCapitalReplacement: true,
                    status: 'Completed',
                    periodKey: '2026-10'
                }
            ]);
        }

        const existingExpensesOct = await TransportExpense.countDocuments({ company: companyId, periodKey: '2026-10' });
        if (existingExpensesOct === 0) {
            await TransportExpense.create([
                {
                    company: companyId,
                    expenseDate: new Date('2026-10-05'),
                    periodKey: '2026-10',
                    category: 'Shared_Overhead',
                    costClassification: 'SharedCommon',
                    amount: 4500,
                    allocationTargetType: 'Shared',
                    sharedAllocationMethod: 'ByKm',
                    vendor: 'SafeTrack GPS & Control Room',
                    referenceNo: 'GPS-OCT-26',
                    description: 'Central Transport Control Room & Fleet Monitoring Subscription (Allocated by KM)'
                },
                {
                    company: companyId,
                    expenseDate: new Date('2026-10-12'),
                    periodKey: '2026-10',
                    category: 'Toll_FASTag',
                    costClassification: 'DirectVariable',
                    amount: 850,
                    allocationTargetType: 'Bus',
                    bus: busDocs[0]._id,
                    route: routeDocs[0]._id,
                    vendor: 'NHAI FASTag',
                    referenceNo: 'FT-1012',
                    description: 'Ajmer Road Ring Corridor FASTag Deducted'
                },
                {
                    company: companyId,
                    expenseDate: new Date('2026-10-14'),
                    periodKey: '2026-10',
                    category: 'Other',
                    costClassification: 'DirectVariable',
                    amount: 1200,
                    allocationTargetType: 'Unallocated',
                    sharedAllocationMethod: 'None',
                    vendor: 'Jaipur Fire Safety Supplies',
                    referenceNo: 'FS-992',
                    description: 'Spare First-Aid & Fire Extinguisher Refill (Pending Bus Allocation)'
                }
            ]);
        }

        // 9. Run 1 Sample Route Optimization Run so Optimization History has an entry
        const existingOptRuns = await OptimizationRun.countDocuments({ company: companyId });
        if (existingOptRuns === 0) {
            await evaluateRouteRecommendations({
                companyId,
                studentName: 'Rohan Khandelwal (New Admission Inquiry)',
                address: 'Amrapali Circle, Vaishali Nagar, Jaipur',
                lat: 26.9115,
                lng: 75.7412,
                shift: 'Both',
                direction: 'Two-Way',
                searchRadiusKm: 8,
                saveRun: true
            });
        }

        console.log('School Fleet Financial, Capacity & Route Intelligence seed completed.');
        return { companyId, skipped: false };
    } catch (error) {
        console.error('Transport Seed Error:', error);
        throw error;
    }
};

// Allow standalone CLI execution: node scripts/seedTransportModule.js
if (require.main === module) {
    dotenv.config({ path: path.join(__dirname, '../.env') });
    mongoose
        .connect(process.env.MONGODB_URI)
        .then(async () => {
            await seedTransportData();
            process.exit(0);
        })
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { seedTransportData };
