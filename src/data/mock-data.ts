import type { Customer } from "../domain/customer.js";
import type { Document } from "../domain/document.js";
import type { Invoice } from "../domain/invoice.js";
import type { Order } from "../domain/order.js";
import type { Trip } from "../domain/trip.js";

export const trips: Partial<Record<string, Trip>> = {
  "313": {
    id: "313",
    number: "E101809996",
    orderId: "A4029709",
    carrierId: "carrier-1",
    status: "approved",
    loading: {
      countryCode: "FR",
      city: "Ensues-la-Redonne",
      plannedAt: "2026-06-17T08:00:00Z"
    },
    unloading: {
      countryCode: "DE",
      city: "Raunheim",
      plannedAt: "2026-06-18T12:00:00Z"
    }
  },
  "314": {
    id: "314",
    number: "E101810047",
    orderId: "A4029710",
    carrierId: "carrier-1",
    status: "completed",
    loading: {
      countryCode: "BE",
      city: "Ghent",
      plannedAt: "2026-05-22T07:30:00Z"
    },
    unloading: {
      countryCode: "NL",
      city: "Rotterdam",
      plannedAt: "2026-05-22T14:00:00Z"
    }
  },
  "315": {
    id: "315",
    number: "E101810193",
    orderId: "A4029711",
    carrierId: "carrier-1",
    status: "planned",
    loading: {
      countryCode: "PL",
      city: "Poznan",
      plannedAt: "2026-07-08T06:00:00Z"
    },
    unloading: {
      countryCode: "CZ",
      city: "Brno",
      plannedAt: "2026-07-09T11:30:00Z"
    }
  }
};

export const orders: Partial<Record<string, Order>> = {
  "A4029709": {
    id: "A4029709",
    number: "A4029709",
    customerId: "customer-1",
    status: "confirmed",
    customerReference: "DEMO-PO-2026-1042",
    createdAt: "2026-06-10T09:30:00Z"
  },
  "A4029710": {
    id: "A4029710",
    number: "A4029710",
    customerId: "customer-2",
    status: "completed",
    customerReference: "DEMO-PO-2026-0871",
    createdAt: "2026-05-15T13:20:00Z"
  },
  "A4029711": {
    id: "A4029711",
    number: "A4029711",
    customerId: "customer-1",
    status: "confirmed",
    customerReference: "DEMO-PO-2026-1198",
    createdAt: "2026-07-01T08:45:00Z"
  }
};

export const customers: Partial<Record<string, Customer>> = {
  "carrier-1": {
    id: "carrier-1",
    name: "Baltic Haulage Demo",
    type: "carrier",
    countryCode: "LT",
    vatCode: "LT100000000000",
    status: "active"
  },
  "customer-1": {
    id: "customer-1",
    name: "Northstar Retail Demo",
    type: "customer",
    countryCode: "DE",
    vatCode: "DE000000000",
    status: "active"
  },
  "customer-2": {
    id: "customer-2",
    name: "Blue Meadow Foods Demo",
    type: "customer",
    countryCode: "NL",
    vatCode: "NL000000000B00",
    status: "active"
  }
};

export const invoices: Invoice[] = [
  {
    id: "invoice-1",
    number: "INV-001",
    tripId: "313",
    orderId: "A4029709",
    customerId: "customer-1",
    type: "sales",
    issueDate: "2026-06-19",
    dueDate: "2026-07-19",
    netAmount: 1500,
    vatAmount: 315,
    grossAmount: 1815,
    currency: "EUR",
    status: "open"
  },
  {
    id: "invoice-2",
    number: "PINV-001",
    tripId: "313",
    orderId: "A4029709",
    customerId: "carrier-1",
    type: "purchase",
    issueDate: "2026-06-20",
    dueDate: "2026-07-20",
    netAmount: 1100,
    vatAmount: 231,
    grossAmount: 1331,
    currency: "EUR",
    status: "open"
  },
  {
    id: "invoice-3",
    number: "INV-002",
    tripId: "314",
    orderId: "A4029710",
    customerId: "customer-2",
    type: "sales",
    issueDate: "2026-05-23",
    dueDate: "2026-06-22",
    netAmount: 900,
    vatAmount: 189,
    grossAmount: 1089,
    currency: "EUR",
    status: "paid"
  },
  {
    id: "invoice-4",
    number: "PINV-002",
    tripId: "314",
    orderId: "A4029710",
    customerId: "carrier-1",
    type: "purchase",
    issueDate: "2026-05-24",
    dueDate: "2026-06-23",
    netAmount: 650,
    vatAmount: 136.5,
    grossAmount: 786.5,
    currency: "EUR",
    status: "paid"
  },
  {
    id: "invoice-5",
    number: "INV-003",
    tripId: "315",
    orderId: "A4029711",
    customerId: "customer-1",
    type: "sales",
    issueDate: "2026-07-10",
    dueDate: "2026-08-09",
    netAmount: 1750,
    vatAmount: 367.5,
    grossAmount: 2117.5,
    currency: "EUR",
    status: "open"
  },
  {
    id: "invoice-6",
    number: "PINV-003",
    tripId: "315",
    orderId: "A4029711",
    customerId: "carrier-1",
    type: "purchase",
    issueDate: "2026-07-11",
    dueDate: "2026-08-10",
    netAmount: 1280,
    vatAmount: 268.8,
    grossAmount: 1548.8,
    currency: "EUR",
    status: "open"
  }
];

export const documents: Document[] = [
  {
    id: "document-1",
    tripId: "313",
    orderId: "A4029709",
    type: "cmr",
    fileName: "sample-cmr-313.pdf",
    mimeType: "application/pdf",
    uploadedAt: "2026-06-18T15:45:00Z",
    validationStatus: "validated"
  },
  {
    id: "document-2",
    tripId: "314",
    orderId: "A4029710",
    type: "proof-of-delivery",
    fileName: "sample-pod-314.pdf",
    mimeType: "application/pdf",
    uploadedAt: "2026-05-22T16:10:00Z",
    validationStatus: "validated"
  },
  {
    id: "document-3",
    tripId: "315",
    orderId: "A4029711",
    type: "cmr",
    fileName: "sample-cmr-315.pdf",
    mimeType: "application/pdf",
    uploadedAt: "2026-07-09T14:25:00Z",
    validationStatus: "pending"
  }
];
