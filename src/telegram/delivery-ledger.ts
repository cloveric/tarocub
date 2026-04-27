export type DeliverySource = "post-turn" | "side-channel" | "stream-event" | "telegram-out";

export interface DeliveryAcceptedReceipt {
  path: string;
  realPath?: string;
  fileName: string;
  bytes?: number;
  source: DeliverySource;
}

export interface DeliveryRejectedReceipt {
  path: string;
  reason: string;
  detail?: string;
  source: DeliverySource;
}

export interface DeliveryReceipts {
  accepted: DeliveryAcceptedReceipt[];
  rejected: DeliveryRejectedReceipt[];
}

export class TurnDeliveryLedger {
  private readonly acceptedByPath = new Map<string, DeliveryAcceptedReceipt>();
  private readonly rejectedEntries: DeliveryRejectedReceipt[] = [];
  private readonly rejectedKeys = new Set<string>();

  recordAccepted(receipt: DeliveryAcceptedReceipt): void {
    this.acceptedByPath.set(receipt.realPath ?? receipt.path, receipt);
  }

  recordRejected(receipt: DeliveryRejectedReceipt): void {
    const key = `${receipt.source}\0${receipt.path}\0${receipt.reason}\0${receipt.detail ?? ""}`;
    if (this.rejectedKeys.has(key)) {
      return;
    }
    this.rejectedKeys.add(key);
    this.rejectedEntries.push(receipt);
  }

  merge(receipts: DeliveryReceipts | undefined): void {
    if (!receipts) {
      return;
    }
    for (const receipt of receipts.accepted) {
      this.recordAccepted(receipt);
    }
    for (const receipt of receipts.rejected) {
      this.recordRejected(receipt);
    }
  }

  accepted(): DeliveryAcceptedReceipt[] {
    return [...this.acceptedByPath.values()];
  }

  rejected(): DeliveryRejectedReceipt[] {
    return [...this.rejectedEntries];
  }

  acceptedPaths(): string[] {
    return this.accepted().map((receipt) => receipt.realPath ?? receipt.path);
  }

  hasAcceptedDelivery(): boolean {
    return this.acceptedByPath.size > 0;
  }

  isSatisfiedForDeliverableRequest(): boolean {
    return this.hasAcceptedDelivery();
  }
}
