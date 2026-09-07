import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import type { ReportPayload, TestRow } from './types';

/**
 * Builds `Test-Execution-Report.xlsx` from the collected run data.
 *
 * Two sheets:
 *   - Summary       : run totals + module-wise pass rates + a pass/fail/skip breakdown
 *   - Test Details  : one row per test case
 *
 * Nothing in here knows about specific modules — it renders whatever modules the
 * resolver found, so a new test folder shows up on its own.
 */

const COLOURS = {
    headerBg: 'FF1F3864',
    headerText: 'FFFFFFFF',
    sectionBg: 'FFD9E1F2',
    passed: 'FFC6EFCE',
    passedText: 'FF006100',
    failed: 'FFFFC7CE',
    failedText: 'FF9C0006',
    skipped: 'FFFFEB9C',
    skippedText: 'FF9C6500',
    totalsBg: 'FFF2F2F2',
    border: 'FFBFBFBF',
};

const THIN_BORDER: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: COLOURS.border } },
    left: { style: 'thin', color: { argb: COLOURS.border } },
    bottom: { style: 'thin', color: { argb: COLOURS.border } },
    right: { style: 'thin', color: { argb: COLOURS.border } },
};

function fill(argb: string): ExcelJS.FillPattern {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Paints a row so it reads as a table header. */
function styleHeaderRow(row: ExcelJS.Row): void {
    row.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: COLOURS.headerText }, size: 11 };
        cell.fill = fill(COLOURS.headerBg);
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = THIN_BORDER;
    });
    row.height = 22;
}

/** Green / red / amber depending on the status text. */
function styleStatusCell(cell: ExcelJS.Cell, status: string): void {
    const normalised = status.toLowerCase();

    if (normalised === 'passed') {
        cell.fill = fill(COLOURS.passed);
        cell.font = { bold: true, color: { argb: COLOURS.passedText } };
    } else if (normalised === 'skipped') {
        cell.fill = fill(COLOURS.skipped);
        cell.font = { bold: true, color: { argb: COLOURS.skippedText } };
    } else {
        // failed / timed out / interrupted
        cell.fill = fill(COLOURS.failed);
        cell.font = { bold: true, color: { argb: COLOURS.failedText } };
    }
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} sec`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function buildSummarySheet(workbook: ExcelJS.Workbook, payload: ReportPayload): void {
    const sheet = workbook.addWorksheet('Summary', {
        properties: { defaultRowHeight: 18 },
    });

    sheet.columns = [
        { key: 'module', width: 32 },
        { key: 'total', width: 12 },
        { key: 'passed', width: 12 },
        { key: 'failed', width: 12 },
        { key: 'skipped', width: 12 },
        { key: 'passRate', width: 16 },
    ];

    // ---- Report title -----------------------------------------------------
    sheet.mergeCells('A1:F1');
    const title = sheet.getCell('A1');
    title.value = 'Test Execution Report';
    title.font = { bold: true, size: 18, color: { argb: COLOURS.headerText } };
    title.fill = fill(COLOURS.headerBg);
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 32;

    sheet.mergeCells('A2:F2');
    const subtitle = sheet.getCell('A2');
    subtitle.value =
        `Executed: ${new Date(payload.startedAt).toLocaleString()}` +
        `   |   Run duration: ${formatDuration(payload.durationMs)}` +
        `   |   Environment: ${payload.baseURL}`;
    subtitle.font = { italic: true, size: 10, color: { argb: 'FF44546A' } };
    subtitle.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(2).height = 20;

    // ---- Overall totals ---------------------------------------------------
    sheet.mergeCells('A4:F4');
    const overallHeading = sheet.getCell('A4');
    overallHeading.value = 'Overall Execution Summary';
    overallHeading.font = { bold: true, size: 12 };
    overallHeading.fill = fill(COLOURS.sectionBg);
    overallHeading.alignment = { horizontal: 'left', vertical: 'middle' };

    const overallHeader = sheet.getRow(5);
    overallHeader.values = [
        'Total Test Cases',
        'Total Passed',
        'Total Failed',
        'Total Skipped',
        'Overall Pass %',
        'Run Duration',
    ];
    styleHeaderRow(overallHeader);

    const overallValues = sheet.getRow(6);
    overallValues.values = [
        payload.totals.total,
        payload.totals.passed,
        payload.totals.failed,
        payload.totals.skipped,
        payload.totals.passRate,
        formatDuration(payload.durationMs),
    ];
    overallValues.eachCell((cell, col) => {
        cell.border = THIN_BORDER;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true, size: 12 };
        if (col === 2) cell.font = { bold: true, size: 12, color: { argb: COLOURS.passedText } };
        if (col === 3) cell.font = { bold: true, size: 12, color: { argb: COLOURS.failedText } };
        if (col === 4) cell.font = { bold: true, size: 12, color: { argb: COLOURS.skippedText } };
        if (col === 5) cell.numFmt = '0.0%';
    });
    overallValues.height = 22;

    // ---- Module-wise table ------------------------------------------------
    const moduleHeadingRow = 8;
    sheet.mergeCells(`A${moduleHeadingRow}:F${moduleHeadingRow}`);
    const moduleHeading = sheet.getCell(`A${moduleHeadingRow}`);
    moduleHeading.value = 'Module-wise Results';
    moduleHeading.font = { bold: true, size: 12 };
    moduleHeading.fill = fill(COLOURS.sectionBg);

    const headerRowNumber = moduleHeadingRow + 1;
    const moduleHeader = sheet.getRow(headerRowNumber);
    moduleHeader.values = ['Module', 'Total', 'Passed', 'Failed', 'Skipped', 'Pass %'];
    styleHeaderRow(moduleHeader);

    let rowNumber = headerRowNumber;
    for (const summary of payload.modules) {
        rowNumber += 1;
        const row = sheet.getRow(rowNumber);
        row.values = [
            summary.module,
            summary.total,
            summary.passed,
            summary.failed,
            summary.skipped,
            summary.passRate,
        ];
        row.eachCell((cell, col) => {
            cell.border = THIN_BORDER;
            if (col === 1) {
                cell.alignment = { horizontal: 'left', vertical: 'middle' };
                cell.font = { bold: true };
            } else {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            }
            if (col === 3 && summary.passed > 0) cell.font = { color: { argb: COLOURS.passedText } };
            if (col === 4 && summary.failed > 0) cell.font = { bold: true, color: { argb: COLOURS.failedText } };
            if (col === 5 && summary.skipped > 0) cell.font = { color: { argb: COLOURS.skippedText } };
            if (col === 6) cell.numFmt = '0.0%';
        });
    }

    const firstModuleRow = headerRowNumber + 1;
    const lastModuleRow = rowNumber;

    // Grand total row under the module table.
    if (payload.modules.length > 0) {
        rowNumber += 1;
        const totalsRow = sheet.getRow(rowNumber);
        totalsRow.values = [
            'TOTAL',
            payload.totals.total,
            payload.totals.passed,
            payload.totals.failed,
            payload.totals.skipped,
            payload.totals.passRate,
        ];
        totalsRow.eachCell((cell, col) => {
            cell.border = THIN_BORDER;
            cell.font = { bold: true };
            cell.fill = fill(COLOURS.totalsBg);
            cell.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
            if (col === 6) cell.numFmt = '0.0%';
        });
    }

    // Filter + freeze so long module lists stay usable.
    sheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: lastModuleRow, column: 6 },
    };
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

    // In-cell bar chart for module pass % (Excel data bars — no external chart needed).
    if (lastModuleRow >= firstModuleRow) {
        sheet.addConditionalFormatting({
            ref: `F${firstModuleRow}:F${lastModuleRow}`,
            rules: [
                {
                    type: 'dataBar',
                    priority: 1,
                    minLength: 0,
                    maxLength: 100,
                    cfvo: [
                        { type: 'num', value: 0 },
                        { type: 'num', value: 1 },
                    ],
                    color: { argb: 'FF63BE7B' },
                } as ExcelJS.DataBarRule,
            ],
        });
    }

    // ---- Passed vs Failed vs Skipped breakdown ----------------------------
    const chartHeadingRow = rowNumber + 2;
    sheet.mergeCells(`A${chartHeadingRow}:F${chartHeadingRow}`);
    const chartHeading = sheet.getCell(`A${chartHeadingRow}`);
    chartHeading.value = 'Passed vs Failed vs Skipped';
    chartHeading.font = { bold: true, size: 12 };
    chartHeading.fill = fill(COLOURS.sectionBg);

    const breakdownHeader = sheet.getRow(chartHeadingRow + 1);
    breakdownHeader.values = ['Result', 'Test Cases', '% of Total'];
    styleHeaderRow(breakdownHeader);

    const breakdown: Array<[string, number, string, string]> = [
        ['Passed', payload.totals.passed, COLOURS.passed, COLOURS.passedText],
        ['Failed', payload.totals.failed, COLOURS.failed, COLOURS.failedText],
        ['Skipped', payload.totals.skipped, COLOURS.skipped, COLOURS.skippedText],
    ];

    breakdown.forEach(([label, count, bg, fg], index) => {
        const row = sheet.getRow(chartHeadingRow + 2 + index);
        row.values = [label, count, payload.totals.total ? count / payload.totals.total : 0];
        row.getCell(1).fill = fill(bg);
        row.getCell(1).font = { bold: true, color: { argb: fg } };
        row.eachCell((cell, col) => {
            cell.border = THIN_BORDER;
            if (col > 1) cell.alignment = { horizontal: 'center', vertical: 'middle' };
            if (col === 3) cell.numFmt = '0.0%';
        });
    });

    const breakdownFirst = chartHeadingRow + 2;
    sheet.addConditionalFormatting({
        ref: `B${breakdownFirst}:B${breakdownFirst + 2}`,
        rules: [
            {
                type: 'dataBar',
                priority: 2,
                minLength: 0,
                maxLength: 100,
                cfvo: [
                    { type: 'num', value: 0 },
                    { type: 'num', value: Math.max(payload.totals.total, 1) },
                ],
                color: { argb: 'FF4472C4' },
            } as ExcelJS.DataBarRule,
        ],
    });
}

function buildDetailsSheet(workbook: ExcelJS.Workbook, tests: TestRow[]): void {
    const sheet = workbook.addWorksheet('Test Details', {
        views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = [
        { header: 'Module', key: 'module', width: 18 },
        { header: 'Test Case', key: 'testCase', width: 52 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Duration', key: 'duration', width: 14 },
        { header: 'Test File', key: 'testFile', width: 38 },
        { header: 'Error Message', key: 'error', width: 60 },
        { header: 'Execution Time', key: 'startTime', width: 22 },
        { header: 'Retry', key: 'retry', width: 8 },
        { header: 'Browser', key: 'project', width: 14 },
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const test of tests) {
        const row = sheet.addRow({
            module: test.module,
            testCase: test.testCase,
            status: test.status,
            duration: Number((test.durationMs / 1000).toFixed(1)),
            testFile: test.testFile,
            error: test.errorMessage,
            startTime: test.startTime ? new Date(test.startTime).toLocaleString() : '',
            retry: test.retry,
            project: test.project,
        });

        row.eachCell({ includeEmpty: true }, (cell) => {
            cell.border = THIN_BORDER;
            cell.alignment = { vertical: 'top', wrapText: true };
        });

        styleStatusCell(row.getCell('status'), test.status);

        const duration = row.getCell('duration');
        duration.numFmt = '0.0" sec"';
        duration.alignment = { horizontal: 'center', vertical: 'top' };

        row.getCell('retry').alignment = { horizontal: 'center', vertical: 'top' };
        row.getCell('module').font = { bold: true };
    }

    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(sheet.rowCount, 1), column: 9 },
    };
}

/** Writes the workbook to `filePath`, creating parent folders as needed. */
export async function writeExcelReport(payload: ReportPayload, filePath: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Playwright Automation';
    workbook.created = new Date(payload.generatedAt);

    buildSummarySheet(workbook, payload);
    buildDetailsSheet(workbook, payload.tests);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await workbook.xlsx.writeFile(filePath);
}
