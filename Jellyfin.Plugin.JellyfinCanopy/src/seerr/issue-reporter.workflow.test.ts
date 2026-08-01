import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { SeerrModalOptions } from './modal';

describe('Seerr issue reporter create and history workflow', () => {
    let modalOptions: SeerrModalOptions;
    let modalElement: HTMLElement;
    let closeModal: ReturnType<typeof vi.fn<() => void>>;
    let disposeReporter: () => void;
    let fetchIssuesForMedia: ReturnType<typeof vi.fn>;
    let fetchIssueById: ReturnType<typeof vi.fn>;
    let reportIssue: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';
        closeModal = vi.fn<() => void>();
        fetchIssuesForMedia = vi.fn();
        fetchIssueById = vi.fn();
        reportIssue = vi.fn();

        JC.pluginConfig = {};
        JC.t = (key: string) => ({
            seerr_existing_issues: 'Existing issues',
            seerr_issue_open: 'Open',
            seerr_issue_resolved: 'Resolved',
            seerr_load_issues_error: 'Could not load issues',
            seerr_loading_issues: 'Loading issues',
            seerr_no_issues_yet: 'No issues',
            seerr_report_issue_submit: 'Submit',
            seerr_report_issue_submitting: 'Submitting',
            seerr_report_issue_success: 'Issue reported',
            seerr_report_issue_type_video: 'Video',
            seerr_report_issue_type_audio: 'Audio',
            seerr_report_issue_type_subtitles: 'Subtitles',
            seerr_report_issue_type_other: 'Other',
        } as Record<string, string>)[key] ?? key;
        JC.escapeHtml = (value: unknown) => String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
        JC.icon = vi.fn(() => '<span></span>');
        JC.IconName = {
            VIDEO: 'video',
            AUDIO: 'audio',
            SUBTITLES: 'subtitles',
            QUESTION: 'question',
        };
        JC.toast = vi.fn();
        JC.seerrAPI = {
            fetchIssuesForMedia,
            fetchIssueById,
            reportIssue,
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        JC.seerrModal = {
            create: vi.fn((options: SeerrModalOptions) => {
                modalOptions = options;
                modalElement = document.createElement('div');
                modalElement.innerHTML = options.bodyHtml;
                document.body.appendChild(modalElement);
                return {
                    modalElement,
                    show: vi.fn(),
                    close: closeModal,
                };
            }),
            closeAll: vi.fn(),
            createAdvancedOptionsHTML: vi.fn(() => ''),
            populateAdvancedOptions: vi.fn(),
        };

        const { installSeerrIssueReporter } = await import('./issue-reporter');
        disposeReporter = installSeerrIssueReporter();
    });

    afterEach(() => {
        disposeReporter?.();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    function openMovieModal(): void {
        JC.seerrIssueReporter!.showReportModal('42', 'Example Movie', 'movie');
    }

    it('keeps the modal open and refreshes through list then detail after a successful create', async () => {
        fetchIssuesForMedia
            .mockResolvedValueOnce({ results: [] })
            .mockResolvedValueOnce({ results: [{ id: 71, issueType: 1, status: 1 }] });
        fetchIssueById.mockResolvedValue({
            id: 71,
            issueType: 1,
            status: 1,
            message: 'Fresh detail',
            comments: [],
            createdBy: { displayName: 'Reporter' },
        });
        reportIssue.mockResolvedValue({ id: 71 });

        openMovieModal();
        await vi.waitFor(() => {
            expect(modalElement.querySelector('.seerr-issues-empty')?.textContent).toBe('No issues');
        });

        modalElement.querySelector<HTMLInputElement>('input[name="issue-type"][value="1"]')!.checked = true;
        modalElement.querySelector<HTMLTextAreaElement>('#issue-message')!.value = 'Fresh detail';
        const submit = document.createElement('button');

        await modalOptions.onSave(modalElement, submit, closeModal);

        expect(reportIssue).toHaveBeenCalledWith('42', 'movie', '1', 'Fresh detail', 0, 0);
        expect(fetchIssuesForMedia).toHaveBeenNthCalledWith(2, '42', 'movie', expect.objectContaining({
            all: true,
            filter: 'all',
            fresh: true,
            signal: expect.any(AbortSignal),
        }));
        expect(fetchIssueById).toHaveBeenCalledWith(71, expect.objectContaining({
            fresh: true,
            signal: expect.any(AbortSignal),
        }));
        expect(reportIssue.mock.invocationCallOrder[0]).toBeLessThan(fetchIssuesForMedia.mock.invocationCallOrder[1]);
        expect(fetchIssuesForMedia.mock.invocationCallOrder[1]).toBeLessThan(fetchIssueById.mock.invocationCallOrder[0]);
        expect(modalElement.querySelector('.seerr-issue-message')?.textContent).toBe('Fresh detail');
        expect(modalElement.querySelector('.seerr-issues-error')).toBeNull();
        expect(modalElement.isConnected).toBe(true);
        expect(closeModal).not.toHaveBeenCalled();
        expect(submit.disabled).toBe(false);
        expect(submit.textContent).toBe('Submit');
    });

    it('renders a list failure as an alert, not a normal empty history', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fetchIssuesForMedia.mockRejectedValue(new Error('list unavailable'));

        openMovieModal();

        await vi.waitFor(() => {
            expect(modalElement.querySelector('.seerr-issues-error')?.textContent)
                .toBe('Could not load issues');
        });
        expect(modalElement.querySelector('.seerr-issues-error')?.getAttribute('role')).toBe('alert');
        expect(modalElement.querySelector('.seerr-issues-empty')).toBeNull();
        expect(fetchIssueById).not.toHaveBeenCalled();
    });

    it('renders a detail failure as an alert instead of a partial successful history', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fetchIssuesForMedia.mockResolvedValue({
            results: [{ id: 71, issueType: 1, status: 1, message: 'Incomplete summary' }],
        });
        fetchIssueById.mockRejectedValue(new Error('detail unavailable'));

        openMovieModal();

        await vi.waitFor(() => {
            expect(modalElement.querySelector('.seerr-issues-error')?.textContent)
                .toBe('Could not load issues');
        });
        expect(modalElement.querySelector('.seerr-issues-error')?.getAttribute('role')).toBe('alert');
        expect(modalElement.querySelector('.seerr-issues-empty')).toBeNull();
        expect(modalElement.querySelector('.seerr-issue-card')).toBeNull();
    });

    it('does not render a post-create empty list when the created issue is missing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fetchIssuesForMedia
            .mockResolvedValueOnce({ results: [] })
            .mockResolvedValueOnce({ results: [] });
        reportIssue.mockResolvedValue({ id: 71 });

        openMovieModal();
        await vi.waitFor(() => {
            expect(modalElement.querySelector('.seerr-issues-empty')?.textContent).toBe('No issues');
        });
        modalElement.querySelector<HTMLInputElement>('input[name="issue-type"][value="1"]')!.checked = true;
        const submit = document.createElement('button');

        await modalOptions.onSave(modalElement, submit, closeModal);

        expect(modalElement.querySelector('.seerr-issues-error')?.textContent)
            .toBe('Could not load issues');
        expect(modalElement.querySelector('.seerr-issues-error')?.getAttribute('role')).toBe('alert');
        expect(modalElement.querySelector('.seerr-issues-empty')).toBeNull();
        expect(fetchIssueById).not.toHaveBeenCalled();
        expect(closeModal).not.toHaveBeenCalled();
    });
});
