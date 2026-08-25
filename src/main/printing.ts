import fs from 'node:fs';
import { app, dialog } from 'electron';
import path from 'node:path';
import type {
  PrintExecuteOptions,
  PrintExecuteResult,
  PrinterInfo,
  PrintMarginType,
  PrintPreviewOptions,
} from '../shared/types';
import { pageRangesToString, parsePageRanges } from '../shared/printUtils';
import { t } from './i18n';
import type { TabManager } from './tabs/TabManager';

/**
 * Real-browser printing: the chrome UI hosts a preview dialog (PDF rendered
 * by printToPDF shown in an iframe) with printer/copies/layout/pages/color
 * options, then we either print silently with those options or save a PDF.
 * The old flow was a bare `wc.print()`: the stock Electron system dialog.
 */
export class PrintController {
  constructor(private readonly tabs: TabManager) {}

  private webContentsFor(tabId: string): Electron.WebContents | null {
    const tab = this.tabs.getAll().find((t) => t.id === tabId);
    // A discarded tab has no webContents: nothing to print (the UI only offers
    // printing for the active tab, which is never discarded).
    if (!tab || tab.isInternal || !tab.view) return null;
    const wc = tab.view.webContents;
    return wc.isDestroyed() ? null : wc;
  }

  async listPrinters(tabId: string): Promise<PrinterInfo[]> {
    const wc = this.webContentsFor(tabId);
    if (!wc) return [];
    try {
      const printers = await wc.getPrintersAsync();
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
      }));
    } catch {
      return [];
    }
  }

  /** Render the page as PDF with the layout options; returns base64. */
  async preview(tabId: string, opts: PrintPreviewOptions): Promise<string | null> {
    const wc = this.webContentsFor(tabId);
    if (!wc) return null;
    try {
      const buffer = await wc.printToPDF(this.pdfOptions(opts));
      return buffer.toString('base64');
    } catch {
      return null;
    }
  }

  async execute(tabId: string, opts: PrintExecuteOptions): Promise<PrintExecuteResult> {
    const wc = this.webContentsFor(tabId);
    if (!wc) return { ok: false, error: t('Onglet introuvable.') };

    if (opts.deviceName === null) return this.saveAsPdf(wc, opts);

    const ranges = parsePageRanges(opts.pageRanges);
    return new Promise<PrintExecuteResult>((resolve) => {
      wc.print(
        {
          silent: true,
          deviceName: opts.deviceName as string,
          copies: Math.max(1, Math.min(99, Math.round(opts.copies))),
          landscape: opts.landscape,
          margins: { marginType: opts.marginType },
          color: opts.color,
          printBackground: opts.printBackground,
          // webContents.print page indexes are 0-based inclusive.
          pageRanges: ranges.map((r) => ({ from: r.from - 1, to: r.to - 1 })),
        },
        (success, failureReason) => {
          resolve(success ? { ok: true } : { ok: false, error: failureReason || t('Échec de l’impression.') });
        },
      );
    });
  }

  private async saveAsPdf(
    wc: Electron.WebContents,
    opts: PrintExecuteOptions,
  ): Promise<PrintExecuteResult> {
    const suggested = sanitizeFilename(wc.getTitle() || 'document') + '.pdf';
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: t('Enregistrer en PDF'),
      defaultPath: path.join(app.getPath('downloads'), suggested),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'cancelled' };
    try {
      const buffer = await wc.printToPDF(this.pdfOptions(opts));
      await fs.promises.writeFile(filePath, buffer);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : t('Écriture du PDF impossible.') };
    }
  }

  /**
   * printToPDF wants numeric margins in inches, not the `marginType` presets
   * `webContents.print()` takes. Electron typed printToPDF's margins as print()'s
   * `Margins` until 43.4.1 (it now has its own `PrintToPDFMargins`), but the
   * runtime never read `marginType` there, so the preset was silently dropped and
   * every PDF came out with the default margins. `printableArea` collapses to 0:
   * a PDF has no unprintable border, so the preset only means something on a
   * physical device, where `execute()` still passes `marginType` straight through.
   */
  private static readonly PDF_MARGIN_INCHES: Record<PrintMarginType, number> = {
    default: 0.4, // Chromium's own printToPDF default (1cm).
    printableArea: 0,
    none: 0,
  };

  private pdfOptions(opts: PrintPreviewOptions): Electron.PrintToPDFOptions {
    const ranges = parsePageRanges(opts.pageRanges);
    const margin = PrintController.PDF_MARGIN_INCHES[opts.marginType];
    const pdf: Electron.PrintToPDFOptions = {
      landscape: opts.landscape,
      printBackground: opts.printBackground,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
    };
    if (ranges.length > 0) pdf.pageRanges = pageRangesToString(ranges);
    return pdf;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
}
