import type { InvoiceData, InvoiceLineItem, InvoiceTradeIn } from './types';

const number = (value: number | undefined) => Number(value) || 0;

export const formatCurrency = (value: number | undefined) =>
  `${number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Rs.`;

export const invoiceTitle = (type: InvoiceData['type']) =>
  type === 'proforma' ? 'QUOTATION' : type === 'sale' ? 'TAX INVOICE' : 'PURCHASE BILL';

export function amountInWords(value: number): string {
  if (!value) return 'Zero Rupees Only';
  const ones = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const words = (input: number) => {
    let result = '';
    if (input > 99) { result += `${ones[Math.floor(input / 100)]}Hundred `; input %= 100; }
    if (input > 19) { result += `${tens[Math.floor(input / 10)]} `; input %= 10; }
    return result + ones[input];
  };
  let input = Math.round(value); let result = '';
  if (input > 9999999) { result += `${words(Math.floor(input / 10000000))}Crore `; input %= 10000000; }
  if (input > 99999) { result += `${words(Math.floor(input / 100000))}Lakh `; input %= 100000; }
  if (input > 999) { result += `${words(Math.floor(input / 1000))}Thousand `; input %= 1000; }
  return `${result}${words(input)}`.trim() + ' Rupees Only';
}

export interface InvoiceViewModel extends InvoiceData {
  title: string;
  formattedDate: string;
  amountWords: string;
  items: (InvoiceLineItem & { descriptionText: string; detailsText: string; rateText: string; discountText: string; amountText: string })[];
  trade_ins: (InvoiceTradeIn & { descriptionText: string; amountText: string })[];
}

export function buildInvoiceViewModel(data: InvoiceData): InvoiceViewModel {
  return {
    ...data,
    title: invoiceTitle(data.type),
    formattedDate: data.date,
    amountWords: amountInWords(data.final_total),
    items: data.items.map((item) => ({
      ...item,
      descriptionText: item.description || `${item.brand || ''} ${item.model || ''}`.trim(),
      detailsText: [item.ram_rom, item.color, item.imei ? `IMEI: ${item.imei}` : ''].filter(Boolean).join(' • '),
      rateText: formatCurrency(item.rate || item.price),
      discountText: number(item.discount) > 0 ? `− ${formatCurrency(item.discount)}` : '—',
      amountText: formatCurrency(item.value || item.price),
    })),
    trade_ins: (data.trade_ins || []).map((item) => ({
      ...item,
      descriptionText: item.description || `${item.brand || ''} ${item.model || ''}`.trim(),
      amountText: formatCurrency(number(item.qty || 1) * number(item.rate || item.credit_value)),
    })),
  };
}
