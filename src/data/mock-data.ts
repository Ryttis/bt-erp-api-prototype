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
    netAmount: 1000,
    vatAmount: 210,
    grossAmount: 1210,
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
  }
];
