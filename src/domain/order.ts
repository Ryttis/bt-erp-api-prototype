export interface Order {
  id: string;
  number: string;
  customerId: string;
  status: string;
  customerReference?: string;
  createdAt: string;
}
