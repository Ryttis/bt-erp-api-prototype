export interface TripStop {
  countryCode: string;
  city: string;
  address?: string;
  plannedAt: string;
}

export interface Trip {
  id: string;
  number: string;
  orderId: string;
  carrierId: string;
  status: string;
  loading: TripStop;
  unloading: TripStop;
}
