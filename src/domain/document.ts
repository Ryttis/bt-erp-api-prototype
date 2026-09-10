export interface Document {
  id: string;
  tripId?: string;
  orderId?: string;
  type: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
  validationStatus: string;
}
