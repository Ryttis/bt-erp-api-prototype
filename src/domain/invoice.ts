export type InvoiceType = "sales" | "purchase";

export interface Invoice {
  id: string;
  number: string;
  tripId?: string;
  orderId?: string;
  customerId: string;
  type: InvoiceType;
  issueDate: string;
  dueDate: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  currency: string;
  status: string;
}
