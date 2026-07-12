import fs from 'node:fs';
import { app, dialog } from 'electron';
import path from 'node:path';
import type {
  PrintExecuteOptions,
  PrintExecuteResult,
  PrinterInfo,
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

  private pdfOptions(opts: PrintPreviewOptions): Electron.PrintToPDFOptions {
    const ranges = parsePageRanges(opts.pageRanges);
    const pdf: Electron.PrintToPDFOptions = {
      landscape: opts.landscape,
      printBackground: opts.printBackground,
      margins: { marginType: opts.marginType },
    };
    if (ranges.length > 0) pdf.pageRanges = pageRangesToString(ranges);
    return pdf;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
}
