export const trips = {
  "313": {
    id: "313",
    number: "E101809996",
    orderId: "A4029709",
    carrierCustomerId: "carrier-1",
    status: "approved"
  }
};

export const orders = {
  "A4029709": {
    id: "A4029709",
    number: "A4029709",
    customerId: "customer-1"
  }
};

export const customers = {
  "carrier-1": { id: "carrier-1", name: "Carrier One", country: "LT" },
  "customer-1": { id: "customer-1", name: "Customer One", country: "LT" }
};

export const invoices = [
  {
    id: "invoice-1",
    tripId: "313",
    number: "INV-001",
    amount: 1250.50,
    currency: "EUR",
    status: "open"
  }
];

export const documents = [
  {
    id: "document-1",
    tripId: "313",
    type: "cmr",
    fileName: "cmr.pdf",
    validationStatus: "validated"
  }
];
