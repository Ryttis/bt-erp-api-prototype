# bt-erp-api-prototype

Prototype ERP API for future MCP integration.

Initial endpoint groups:

- Trip API
- Order API
- Customer API
- Invoice API
- Documents API

## Run locally

```bash
npm install
npm run dev
```

## Test

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/trips/313
curl http://localhost:3000/api/orders/A4029709
curl http://localhost:3000/api/customers/customer-1
curl "http://localhost:3000/api/invoices?tripId=313"
curl "http://localhost:3000/api/documents?tripId=313"
```

## Docker

```bash
docker compose up --build -d
```

This repository intentionally contains only mock/sample data.
