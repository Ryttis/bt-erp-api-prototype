export type CustomerType = "customer" | "carrier";
export type CustomerStatus = "active" | "inactive";

export interface Customer {
  id: string;
  name: string;
  type: CustomerType;
  countryCode: string;
  vatCode?: string;
  status: CustomerStatus;
}
