import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';

const getContext = () => SillyTavern.getContext();
const getCallPopup = () => getContext().callPopup;
const executeSlashCommands = (cmd) => getContext().executeSlashCommands(cmd);

function bcxStampDialogueButtons(on) {
    const ok = document.getElementById('dialogue_popup_ok');
    const cancel = document.getElementById('dialogue_popup_cancel');
    if (on) {
        ok?.classList.add('bcx-btn', 'bcx-btn-ok');
        cancel?.classList.add('bcx-btn', 'bcx-btn-cancel');
    } else {
        ok?.classList.remove('bcx-btn', 'bcx-btn-ok');
        cancel?.classList.remove('bcx-btn', 'bcx-btn-cancel');
    }
}

function bcxCallPopup(content, type, inputValue = '', options = {}) {
    const promise = getCallPopup()(content, type, inputValue, options);

    requestAnimationFrame(() => bcxStampDialogueButtons(true));
    setTimeout(() => bcxStampDialogueButtons(true), 0);
    setTimeout(() => bcxStampDialogueButtons(true), 50);

    return Promise.resolve(promise).finally(() => {
        setTimeout(() => bcxStampDialogueButtons(false), 100);
    });
}

const extensionName = 'broadcast-message';

const defaultSettings = {
    autoHide: true,
    showBroadcastBtn: true,
    showHideBtn: true,
    showBackupBtn: true,
    showSimulBtn: true,
    expectedPersona: '',
    messageCount: 1,

    moveChars: {},
    moveMode: 'new',
    moveName: '시뮬 {{date}}',
    moveOriginal: 'delete',
    moveUnhide: true,
};

let isProcessing = false;
let isPaused = false;
let shouldStop = false;
let selectedChats = [];
let currentBroadcastMessages = [];
let currentMessageIndex = 0;
let currentCharIndex = 0;
let lastCheckedBackupIndex = null;

const MOBILE_QUERY = '(max-width: 600px)';
const pinnedPanels = new Map();

function isMobileUI() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

function pinToViewport(el) {
    if (!el) return;
    const vv = window.visualViewport;

    const apply = () => {
        if (!el.isConnected) return unpinFromViewport(el);

        if (!vv || !isMobileUI()) {
            el.style.top = el.style.left = el.style.width = el.style.height = '';
            return;
        }

        el.style.left = `${vv.offsetLeft}px`;
        el.style.width = `${vv.width}px`;
        el.style.top = `${vv.offsetTop}px`;
        el.style.height = `${vv.height}px`;
    };

    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    pinnedPanels.set(el, apply);
}

function unpinFromViewport(el) {
    const apply = pinnedPanels.get(el);
    if (!apply) return;
    window.visualViewport?.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
    pinnedPanels.delete(el);
}

function escapeAttr(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bcxModal(o) {
    return new Promise((resolve) => {
        const $ov = $(`
            <div class="bcx-ov">
                <div class="bcx-modal bcx-modal--${o.size || 'lg'}" role="dialog" aria-modal="true">
                    <div class="bcx-mh">
                        <div class="bcx-mt">${o.title}</div>
                        ${o.steps || ''}
                        <button type="button" class="bcx-x" data-bcx-cancel title="닫기">✕</button>
                    </div>
                    <div class="bcx-mb">${o.body}</div>
                    <div class="bcx-mf">
                        <span class="bcx-sum"></span>
                        <button type="button" class="bcx-b bcx-b--ghost" data-bcx-cancel>${o.cancelText || '취소'}</button>
                        <button type="button" class="bcx-b bcx-b--pri" data-bcx-ok>${o.okText || '확인'}</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append($ov);
        const root = $ov[0];
        pinToViewport(root);

        let done = false;
        const close = (result) => {
            if (done) return;
            done = true;
            unpinFromViewport(root);
            $ov.remove();
            document.removeEventListener('keydown', onKey, true);
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(false);
            }
        };
        document.addEventListener('keydown', onKey, true);

        $ov.on('click', '[data-bcx-cancel]', () => close(false));
        $ov.on('mousedown', (e) => {
            if (e.target === root && !isMobileUI()) close(false);
        });
        $ov.on('click', '[data-bcx-ok]', async () => {
            if (o.onOk) {
                const ok = await o.onOk(root);
                if (ok === false) return;
            }
            close(true);
        });

        $ov.on('click', '.bcx-sw', function () {
            $(this).toggleClass('on').attr('aria-pressed', $(this).hasClass('on'));
            $(this).trigger('bcx-change');
        });
        $ov.on('click', '.bcx-seg button', function () {
            $(this).addClass('on').siblings().removeClass('on');
            $(this).closest('.bcx-seg').trigger('bcx-change');
        });

        o.onMount?.(root);
    });
}

const sw = (on, attrs = '') => `<button type="button" class="bcx-sw ${on ? 'on' : ''}" aria-pressed="${!!on}" ${attrs}></button>`;
const seg = (id, options, value) => `
    <div class="bcx-seg" id="${id}">
        ${options.map(([v, label]) => `<button type="button" data-v="${v}" class="${v === value ? 'on' : ''}">${label}</button>`).join('')}
    </div>`;
const segValue = (root, id) => $(root).find(`#${id} button.on`).data('v');

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = structuredClone(value);
        }
    }
}

function createSettingsUI() {
    const settingsHtml = `
        <div class="broadcast-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>브로드캐스트 설정</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="bcx-settings-item">
                        <label class="bcx-inline-label">
                            <input type="checkbox" id="broadcast-show-broadcast-btn" ${extension_settings[extensionName].showBroadcastBtn ? 'checked' : ''}>
                            <span>브로드캐스트 버튼 표시</span>
                        </label>
                    </div>
                    <div class="bcx-settings-item">
                        <label class="bcx-inline-label">
                            <input type="checkbox" id="broadcast-show-hide-btn" ${extension_settings[extensionName].showHideBtn ? 'checked' : ''}>
                            <span>메시지 숨기기 버튼 표시</span>
                        </label>
                    </div>
                    <div class="bcx-settings-item">
                        <label class="bcx-inline-label">
                            <input type="checkbox" id="broadcast-show-backup-btn" ${extension_settings[extensionName].showBackupBtn ? 'checked' : ''}>
                            <span>백업 버튼 표시</span>
                        </label>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);

    $('#broadcast-show-broadcast-btn').on('change', function() {
        extension_settings[extensionName].showBroadcastBtn = this.checked;
        saveSettingsDebounced();
        updateButtonVisibility();
    });

    $('#broadcast-show-hide-btn').on('change', function() {
        extension_settings[extensionName].showHideBtn = this.checked;
        saveSettingsDebounced();
        updateButtonVisibility();
    });

    $('#broadcast-show-backup-btn').on('change', function() {
        extension_settings[extensionName].showBackupBtn = this.checked;
        saveSettingsDebounced();
        updateButtonVisibility();
    });
}

function updateButtonVisibility() {
    $('#broadcast-btn').toggle(extension_settings[extensionName].showBroadcastBtn);
    $('#hide-btn').toggle(extension_settings[extensionName].showHideBtn);
    $('#backup-btn').toggle(extension_settings[extensionName].showBackupBtn);
}

async function getChatList() {
    const ctx = getContext();
    const characters = [];

    if (ctx.characters && ctx.characters.length > 0) {
        ctx.characters.forEach((char, index) => {
            if (char.name) {
                characters.push({
                    chid: index,
                    name: char.name,
                    avatar: char.avatar,
                });
            }
        });
    }

    $('.group_select').each(function() {
        const $this = $(this);
        const grid = $this.attr('grid');
        const name = $this.find('.ch_name').text().trim();

        if (name) {
            characters.push({
                grid: grid,
                name: name,
                isGroup: true,
            });
        }
    });

    return characters;
}

function todayMMDD() {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function resolveMoveName(template) {
    return String(template || '').replace(/\{\{date\}\}/gi, todayMMDD()).trim();
}

function msgItemHtml(index, value = '') {
    return `
        <div class="bcx-msg">
            <span class="bcx-num">${index + 1}</span>
            <textarea class="bcx-ta broadcast-message-input" rows="2" placeholder="메시지 ${index + 1}">${escapeAttr(value)}</textarea>
            <button type="button" class="bcx-del" title="삭제">✕</button>
        </div>`;
}

async function openChatSelector() {
    if (isProcessing) {
        toastr.warning('이미 브로드캐스트가 진행 중입니다.');
        return;
    }

    const chats = await getChatList();

    if (chats.length === 0) {
        toastr.info('사용 가능한 캐릭터가 없습니다.');
        return;
    }

    const nowCtx = getContext();
    const currentAvatar = !nowCtx.groupId && nowCtx.characterId !== undefined ? nowCtx.characters[nowCtx.characterId]?.avatar : null;
    const isCurrent = (c) => nowCtx.groupId ? (c.isGroup && String(c.grid) === String(nowCtx.groupId)) : (!c.isGroup && !!currentAvatar && c.avatar === currentAvatar);
    const currentPos = chats.findIndex(isCurrent);
    if (currentPos > 0) chats.unshift(...chats.splice(currentPos, 1));

    const s = extension_settings[extensionName];
    const savedMessageCount = Math.max(1, s.messageCount || 1);

    const rowHtml = (c, index) => {
        const avatar = c.isGroup
            ? '<span class="bcx-av bcx-av--grp">👥</span>'
            : `<img class="bcx-av" loading="lazy" src="/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}" alt="">`;
        const moveOn = !c.isGroup && !!s.moveChars?.[c.avatar];
        return `
            <label class="bcx-crow" data-name="${escapeAttr(c.name.toLowerCase())}">
                <input type="checkbox"
                       class="broadcast-chat-checkbox"
                       data-index="${index}"
                       data-chid="${c.chid ?? ''}"
                       data-grid="${c.grid || ''}"
                       data-name="${escapeAttr(c.name)}"
                       data-avatar="${escapeAttr(c.avatar || '')}"
                       data-is-group="${c.isGroup || false}"
                       ${isCurrent(c) ? 'checked' : ''}>
                ${avatar}
                <span class="bcx-cname">${escapeAttr(c.name)}</span>
                ${c.isGroup
                    ? '<span class="bcx-mv bcx-mv--na" title="그룹 채팅은 옮기기를 지원하지 않아요">📦 그룹 불가</span>'
                    : `<button type="button" class="bcx-mv ${moveOn ? 'on' : ''}" data-avatar="${escapeAttr(c.avatar)}">📦 ${moveOn ? '옮김' : '안 옮김'}</button>`}
            </label>`;
    };

    const body = `
        <section class="bcx-card" id="bcx-sec-target">
            <div class="bcx-ch"><b>보낼 대상</b><span class="bcx-cnt" id="bcx-target-cnt">0 / ${chats.length}</span>
                <button type="button" class="bcx-link" id="broadcast-select-all">전체 선택</button></div>
            <input type="search" class="bcx-search" id="bcx-target-search" placeholder="🔍 이름 검색">
            <div class="bcx-crows">${chats.map(rowHtml).join('')}</div>
        </section>

        <section class="bcx-card" id="bcx-sec-msg">
            <div class="bcx-ch"><b>보낼 메시지</b><span class="bcx-cnt" id="bcx-msg-cnt">${savedMessageCount}개</span></div>
            <div id="broadcast-message-inputs">${Array.from({ length: savedMessageCount }, (_, i) => msgItemHtml(i)).join('')}</div>
            <button type="button" class="bcx-add" id="bcx-msg-add">＋ 메시지 추가</button>
            <small class="bcx-hint">캐릭터마다 위에서부터 한 개씩 보내고, 답이 오면 숨긴 뒤 다음 메시지를 보내요.</small>
        </section>

        <section class="bcx-card" id="bcx-sec-opt">
            <div class="bcx-ch"><b>옵션</b></div>
            <div class="bcx-opt"><span>보낸 메시지·응답 자동 숨김</span>${sw(s.autoHide, 'id="broadcast-auto-hide"')}</div>
        </section>

        <section class="bcx-card bcx-card--move" id="bcx-sec-move">
            <div class="bcx-ch"><b>📦 다 돌린 뒤 옮기기</b></div>
            <p class="bcx-desc">📦 켠 캐릭터만 — 메시지를 전부 보내고 숨긴 뒤, 이번에 숨긴 것들을 한꺼번에 아래 파일로 옮기고 다음 캐릭터로 넘어가요.</p>
            <div class="bcx-f"><span class="bcx-l">옮길 곳</span>
                ${seg('bcx-move-mode', [['new', '새 파일 만들기'], ['append', '같은 이름 파일에 이어붙이기']], s.moveMode)}</div>
            <div class="bcx-f"><span class="bcx-l">파일 이름 (캐릭터마다 이 이름으로)</span>
                <input type="text" class="bcx-in" id="bcx-move-name" value="${escapeAttr(s.moveName)}" placeholder="시뮬 {{date}}">
                <small class="bcx-hint">{{date}} = 오늘 날짜 → <b id="bcx-move-preview">${escapeAttr(resolveMoveName(s.moveName))}</b></small></div>
            <div class="bcx-f"><span class="bcx-l">원래 채팅에선</span>
                ${seg('bcx-move-original', [['delete', '지우기 (이동)'], ['keep', '숨긴 채 두기 (복사)']], s.moveOriginal)}</div>
            <div class="bcx-opt"><span>옮긴 파일에선 숨김 풀기</span>${sw(s.moveUnhide, 'id="bcx-move-unhide"')}</div>
        </section>
    `;

    const steps = `
        <div class="bcx-steps">
            <button type="button" data-jump="bcx-sec-target">대상</button>
            <button type="button" data-jump="bcx-sec-msg">메시지</button>
            <button type="button" data-jump="bcx-sec-opt">옵션</button>
        </div>`;

    let collected = null;

    const result = await bcxModal({
        title: '📢 브로드캐스트',
        steps,
        body,
        okText: '보내기',
        size: 'lg',
        onMount(root) {
            const $r = $(root);
            const refresh = () => {
                const $checked = $r.find('.broadcast-chat-checkbox:checked');
                const n = $checked.length;
                const m = $r.find('.broadcast-message-input').filter(function () { return this.value.trim(); }).length;
                const moving = $checked.filter(function () {
                    return $(this).closest('.bcx-crow').find('.bcx-mv.on').length > 0;
                }).length;
                $r.find('#bcx-target-cnt').text(`${n} / ${chats.length}`);
                $r.find('#bcx-msg-cnt').text(`${$r.find('.broadcast-message-input').length}개`);
                $r.find('#broadcast-select-all').text(n === chats.length ? '전체 해제' : '전체 선택');
                $r.find('.bcx-sum').html(`<b>${n}명 × ${m}개</b> = ${n * m}번 생성${moving ? ` · 📦 ${moving}명` : ''}`);
                $r.find('#bcx-sec-move').toggleClass('is-idle', moving === 0);
            };
            const renumber = () => {
                $r.find('.bcx-msg').each(function (i) {
                    $(this).find('.bcx-num').text(i + 1);
                    $(this).find('textarea').attr('placeholder', `메시지 ${i + 1}`);
                });
            };

            $r.on('change', '.broadcast-chat-checkbox', refresh);
            $r.on('input', '.broadcast-message-input', refresh);
            $r.on('click', '#broadcast-select-all', () => {
                const $boxes = $r.find('.broadcast-chat-checkbox');
                const all = $boxes.length === $boxes.filter(':checked').length;
                $r.find('.bcx-crow:visible .broadcast-chat-checkbox').prop('checked', !all);
                refresh();
            });
            $r.on('input', '#bcx-target-search', function () {
                const q = this.value.trim().toLowerCase();
                $r.find('.bcx-crow').each(function () {
                    $(this).toggle(!q || String($(this).data('name')).includes(q));
                });
            });
            $r.on('click', '.bcx-mv[data-avatar]', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const on = !$(this).hasClass('on');
                $(this).toggleClass('on', on).text(`📦 ${on ? '옮김' : '안 옮김'}`);
                refresh();
            });
            $r.on('click', '#bcx-msg-add', () => {
                const n = $r.find('.bcx-msg').length;
                if (n >= 20) return toastr.info('메시지는 20개까지예요.');
                $r.find('#broadcast-message-inputs').append(msgItemHtml(n));
                $r.find('.broadcast-message-input').last().trigger('focus');
                refresh();
            });
            $r.on('click', '.bcx-del', function () {
                if ($r.find('.bcx-msg').length <= 1) {
                    $r.find('.broadcast-message-input').val('');
                } else {
                    $(this).closest('.bcx-msg').remove();
                    renumber();
                }
                refresh();
            });
            $r.on('input', '#bcx-move-name', function () {
                $r.find('#bcx-move-preview').text(resolveMoveName(this.value) || '(비어 있음)');
            });
            $r.on('click', '[data-jump]', function () {
                const target = root.querySelector(`#${$(this).data('jump')}`);
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            refresh();
        },
        onOk(root) {
            const $r = $(root);
            const messages = [];
            $r.find('.broadcast-message-input').each(function () {
                const msg = $(this).val().trim();
                if (msg) messages.push(msg);
            });
            if (messages.length === 0) {
                toastr.warning('최소 하나의 메시지를 입력해주세요.');
                return false;
            }

            const chosen = [];
            $r.find('.broadcast-chat-checkbox:checked').each(function () {
                const isGroup = $(this).data('is-group') === true || $(this).data('is-group') === 'true';
                chosen.push({
                    chid: $(this).data('chid'),
                    grid: $(this).data('grid'),
                    name: String($(this).data('name')),
                    avatar: String($(this).data('avatar') || ''),
                    isGroup,
                    move: !isGroup && $(this).closest('.bcx-crow').find('.bcx-mv.on').length > 0,
                });
            });
            if (chosen.length === 0) {
                toastr.warning('최소 하나의 캐릭터를 선택해주세요.');
                return false;
            }

            const moveName = $r.find('#bcx-move-name').val().trim();
            if (chosen.some(c => c.move) && !resolveMoveName(moveName)) {
                toastr.warning('📦 옮길 파일 이름을 적어주세요.');
                return false;
            }

            const moveChars = { ...(s.moveChars || {}) };
            $r.find('.bcx-mv[data-avatar]').each(function () {
                const av = String($(this).data('avatar'));
                if ($(this).hasClass('on')) moveChars[av] = true;
                else delete moveChars[av];
            });

            s.autoHide = $r.find('#broadcast-auto-hide').hasClass('on');
            s.messageCount = messages.length;
            s.moveChars = moveChars;
            s.moveMode = segValue(root, 'bcx-move-mode') || 'new';
            s.moveOriginal = segValue(root, 'bcx-move-original') || 'delete';
            s.moveUnhide = $r.find('#bcx-move-unhide').hasClass('on');
            s.moveName = moveName || defaultSettings.moveName;
            saveSettingsDebounced();

            collected = { messages, chosen };
            return true;
        },
    });

    if (!result || !collected) return;

    selectedChats = collected.chosen;
    await broadcastMessage(collected.messages, extension_settings[extensionName].autoHide);
}

async function openHideModal() {
    let count = 0;
    const ok = await bcxModal({
        title: '🙈 메시지 숨기기',
        size: 'sm',
        okText: '숨기기',
        body: `
            <section class="bcx-card">
                <div class="bcx-f"><span class="bcx-l">숨길 메시지 개수</span>
                    <input type="number" class="bcx-in" id="hide-count" min="1" max="100" value="2" inputmode="numeric">
                    <small class="bcx-hint">마지막 메시지부터 숨깁니다</small></div>
            </section>`,
        onOk(root) {
            count = parseInt($(root).find('#hide-count').val(), 10);
            if (isNaN(count) || count < 1) {
                toastr.warning('올바른 숫자를 입력해주세요.');
                return false;
            }
            return true;
        },
    });

    if (ok) await hideLastMessages(count);
}

async function hideLastMessages(count) {
    const currentChat = getContext().chat;
    const totalMessages = currentChat.length;

    if (totalMessages === 0) {
        toastr.info('숨길 메시지가 없습니다.');
        return;
    }

    const hideCount = Math.min(count, totalMessages);
    const lastIndex = totalMessages - 1;
    const startIndex = lastIndex - hideCount + 1;

    toastr.info(`마지막 ${hideCount}개 메시지를 숨기는 중...`);

    try {
        await executeSlashCommands(`/hide ${startIndex}-${lastIndex}`);
        await sleep(500);
        toastr.success(`${hideCount}개 메시지를 숨겼습니다.`);
    } catch (error) {
        console.error('[Broadcast] Error hiding messages:', error);
        toastr.error('메시지 숨기기 실패');
    }
}

async function openBackupModal() {
    const ctx = getContext();
    const currentChat = ctx.chat;

    if (!currentChat || currentChat.length === 0) {
        toastr.info('백업할 메시지가 없습니다.');
        return;
    }

    const currentCharId = ctx.characterId;
    if (currentCharId === undefined) {
        toastr.error('캐릭터를 먼저 선택해주세요.');
        return;
    }

    lastCheckedBackupIndex = null;

    const reversedChat = [...currentChat].reverse();
    let selectedIndices = [];

    const body = `
        <section class="bcx-card">
            <div class="bcx-range">
                <div class="bcx-range-box">
                    <input type="number" id="backup-range-start" placeholder="시작" inputmode="numeric">
                    <span>~</span>
                    <input type="number" id="backup-range-end" placeholder="끝" inputmode="numeric">
                </div>
                <button type="button" class="bcx-chip" id="backup-apply-range-btn">✓ 범위 적용</button>
                <button type="button" class="bcx-chip" id="backup-hidden-only-btn">🙈 숨긴 것만</button>
                <button type="button" class="bcx-chip" id="backup-select-all">전체 선택</button>
            </div>
            <small class="bcx-hint">Shift+클릭으로 범위 선택 · 번호를 직접 넣어도 돼요 (최신순)</small>
        </section>
        <div class="bcx-blist">
            ${reversedChat.map((msg, displayIndex) => {
                const realIndex = currentChat.length - 1 - displayIndex;
                const text = String(msg.mes || '');
                return `
                    <label class="bcx-brow">
                        <input type="checkbox"
                               class="backup-msg-checkbox"
                               data-index="${realIndex}"
                               data-display-index="${displayIndex}"
                               data-hidden="${msg.is_system ? 1 : 0}">
                        <div class="bcx-btext">
                            <div class="bcx-bname ${msg.is_user ? 'is-user' : 'is-char'}">
                                <i>[${realIndex}]</i>${escapeAttr(msg.name || (msg.is_user ? 'User' : 'Character'))}${msg.is_system ? '<span class="bcx-hid">숨김</span>' : ''}
                            </div>
                            <div class="bcx-bprev">${escapeAttr(text.substring(0, 140))}${text.length > 140 ? '…' : ''}</div>
                        </div>
                    </label>`;
            }).join('')}
        </div>
    `;

    const result = await bcxModal({
        title: '📦 메시지 백업',
        size: 'lg',
        okText: '다음',
        body,
        onMount(root) {
            const $r = $(root);
            const refresh = () => {
                const n = $r.find('.backup-msg-checkbox:checked').length;
                $r.find('.bcx-sum').text(`${n}개 선택`);
            };
            $r.on('change', '.backup-msg-checkbox', refresh);
            $r.on('click', '.backup-msg-checkbox', function (e) {
                const currentIndex = parseInt($(this).data('display-index'), 10);
                if (e.shiftKey && lastCheckedBackupIndex !== null) {
                    const start = Math.min(lastCheckedBackupIndex, currentIndex);
                    const end = Math.max(lastCheckedBackupIndex, currentIndex);
                    const isChecked = $(this).prop('checked');
                    $r.find('.backup-msg-checkbox').each(function () {
                        const idx = parseInt($(this).data('display-index'), 10);
                        if (idx >= start && idx <= end) $(this).prop('checked', isChecked);
                    });
                    refresh();
                }
                lastCheckedBackupIndex = currentIndex;
            });
            $r.on('click', '#backup-select-all', () => {
                const $b = $r.find('.backup-msg-checkbox');
                $b.prop('checked', $b.length !== $b.filter(':checked').length);
                refresh();
            });
            $r.on('click', '#backup-hidden-only-btn', () => {
                $r.find('.backup-msg-checkbox').each(function () {
                    $(this).prop('checked', String($(this).data('hidden')) === '1');
                });
                refresh();
            });
            $r.on('click', '#backup-apply-range-btn', () => {
                const startIdx = parseInt($r.find('#backup-range-start').val(), 10);
                const endIdx = parseInt($r.find('#backup-range-end').val(), 10);
                if (isNaN(startIdx) || isNaN(endIdx)) {
                    toastr.warning('시작과 끝 인덱스를 입력해주세요.');
                    return;
                }
                const minIdx = Math.min(startIdx, endIdx);
                const maxIdx = Math.max(startIdx, endIdx);
                $r.find('.backup-msg-checkbox').each(function () {
                    const realIdx = parseInt($(this).data('index'), 10);
                    if (realIdx >= minIdx && realIdx <= maxIdx) $(this).prop('checked', true);
                });
                refresh();
                toastr.success(`인덱스 ${minIdx}~${maxIdx} 범위 선택됨`);
            });
            refresh();
        },
        onOk(root) {
            selectedIndices = [];
            $(root).find('.backup-msg-checkbox:checked').each(function () {
                selectedIndices.push(parseInt($(this).data('index'), 10));
            });
            if (selectedIndices.length === 0) {
                toastr.warning('최소 하나의 메시지를 선택해주세요.');
                return false;
            }
            return true;
        },
    });

    if (result) await openBackupTargetSelector(selectedIndices);
}

function removeJsonlExtension(fileName) {
    if (fileName && fileName.endsWith('.jsonl')) {
        return fileName.slice(0, -6);
    }
    return fileName;
}

async function openBackupTargetSelector(selectedIndices) {
    const ctx = getContext();
    const currentCharId = ctx.characterId;
    const currentCharacter = ctx.characters[currentCharId];

    if (!currentCharacter) {
        toastr.error('현재 캐릭터를 찾을 수 없습니다.');
        return;
    }

    const currentChatFileId = removeJsonlExtension(currentCharacter.chat);

    let chatFiles;
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: currentCharacter.avatar,
                simple: true,
            }),
        });
        if (!response.ok) throw new Error('채팅 목록을 가져올 수 없습니다.');
        chatFiles = await response.json();
    } catch (error) {
        console.error('[Broadcast] Error getting chat files:', error);
        toastr.error('채팅 파일 목록을 가져오는데 실패했습니다: ' + error.message);
        return;
    }

    const files = Array.isArray(chatFiles) ? chatFiles : Object.values(chatFiles || {});
    let choice = null;

    const body = `
        <section class="bcx-card">
            <label class="bcx-frow bcx-frow--new">
                <input type="radio" name="backup-target" class="backup-target-radio" data-file-id="__NEW_FILE__" data-is-new="true">
                <span>➕ 새 파일 만들기</span>
            </label>
            <div class="bcx-f" id="new-file-name-container" hidden>
                <input type="text" class="bcx-in" id="new-file-name-input" placeholder="파일 이름 (비워두면 자동)">
            </div>
            <div class="bcx-flist">
                ${files.length > 0 ? files.map((file) => {
                    const fileId = file.file_id || removeJsonlExtension(file.file_name);
                    const displayName = file.file_name || fileId;
                    const isCurrent = fileId === currentChatFileId;
                    return `
                        <label class="bcx-frow ${isCurrent ? 'is-disabled' : ''}">
                            <input type="radio" name="backup-target" class="backup-target-radio"
                                   data-file-id="${escapeAttr(fileId)}" data-is-new="false" ${isCurrent ? 'disabled' : ''}>
                            <span>${escapeAttr(displayName)}${isCurrent ? ' (현재)' : ''}</span>
                        </label>`;
                }).join('') : '<p class="bcx-empty">기존 채팅 파일이 없습니다. 새 파일을 만드세요.</p>'}
            </div>
        </section>
        <section class="bcx-card">
            <div class="bcx-opt"><span>원본 메시지 삭제 (이동)</span>${sw(false, 'id="backup-delete-original"')}</div>
        </section>
    `;

    const result = await bcxModal({
        title: '📁 어디로 옮길까요?',
        size: 'md',
        okText: '실행',
        body,
        onMount(root) {
            const $r = $(root);
            $r.find('.bcx-sum').text(`${selectedIndices.length}개 메시지`);
            $r.on('change', '.backup-target-radio', function () {
                const isNew = String($(this).data('is-new')) === 'true';
                $r.find('#new-file-name-container').prop('hidden', !isNew);
                if (isNew) $r.find('#new-file-name-input').trigger('focus');
            });
        },
        onOk(root) {
            const $r = $(root);
            const $sel = $r.find('.backup-target-radio:checked');
            if (!$sel.length) {
                toastr.warning('대상 채팅 파일을 선택해주세요.');
                return false;
            }
            choice = {
                targetFileId: String($sel.data('file-id')),
                isNew: String($sel.data('is-new')) === 'true',
                newName: $r.find('#new-file-name-input').val().trim(),
                deleteOriginal: $r.find('#backup-delete-original').hasClass('on'),
            };
            return true;
        },
    });

    if (!result || !choice) return;

    if (choice.isNew) {
        await copyMessagesToNewFile(selectedIndices, choice.newName, currentChatFileId, choice.deleteOriginal);
    } else {
        await copyMessagesToFile(selectedIndices, choice.targetFileId, currentChatFileId, choice.deleteOriginal);
    }
}

async function copyMessagesToNewFile(indices, newFileName, currentFileId, deleteOriginal) {
    const ctx = getContext();
    const currentChat = ctx.chat;

    try {
        toastr.info('새 채팅 파일 생성 중...');

        const sortedIndices = [...indices].sort((a, b) => a - b);
        const messagesToCopy = sortedIndices.map(i => JSON.parse(JSON.stringify(currentChat[i])));

        await executeSlashCommands('/newchat');
        await sleep(2000);
        await waitForChatLoad();

        const currentCharId = ctx.characterId;
        const currentCharacter = ctx.characters[currentCharId];
        let newFileId = removeJsonlExtension(currentCharacter.chat);

        if (newFileName) {
            try {
                await executeSlashCommands(`/renamechat ${newFileName.trim()}`);
                newFileId = newFileName.trim();
                await sleep(500);
            } catch (renameError) {
                console.warn('[Broadcast] Rename error:', renameError);
            }
        }

        const newChat = ctx.chat;
        for (const msg of messagesToCopy) {
            newChat.push(msg);
        }

        await ctx.saveChat();
        await sleep(500);

        await ctx.reloadCurrentChat();
        await sleep(500);

        if (deleteOriginal) {
            await ctx.openCharacterChat(currentFileId);
            await sleep(2000);
            await waitForChatLoad();

            const currentChatNow = ctx.chat;
            for (const index of [...indices].sort((a, b) => b - a)) {
                if (index < currentChatNow.length) {
                    currentChatNow.splice(index, 1);
                }
            }
            await ctx.saveChat();
            await ctx.reloadCurrentChat();
            await sleep(500);

            await ctx.openCharacterChat(newFileId);
            await sleep(2000);
            await waitForChatLoad();
        }

        const action = deleteOriginal ? '이동' : '복사';
        const displayName = newFileName || newFileId;
        toastr.success(`${messagesToCopy.length}개 메시지를 새 파일 "${displayName}"로 ${action}했습니다.`);

    } catch (error) {
        console.error('[Broadcast] Error copying messages to new file:', error);
        toastr.error(`메시지 처리 실패: ${error.message}`);

        try {
            await ctx.openCharacterChat(currentFileId);
        } catch (e) {
            console.error('[Broadcast] Failed to return to original chat:', e);
        }
    }
}

async function copyMessagesToFile(indices, targetFileId, currentFileId, deleteOriginal) {
    const ctx = getContext();
    const currentChat = ctx.chat;

    try {
        toastr.info('메시지 처리 중...');

        const sortedIndices = [...indices].sort((a, b) => a - b);
        const messagesToCopy = sortedIndices.map(i => JSON.parse(JSON.stringify(currentChat[i])));

        await ctx.openCharacterChat(targetFileId);
        await sleep(2000);

        await waitForChatLoad();

        const targetChat = ctx.chat;
        for (const msg of messagesToCopy) {
            targetChat.push(msg);
        }

        await ctx.saveChat();
        await sleep(500);

        await ctx.openCharacterChat(currentFileId);
        await sleep(2000);
        await waitForChatLoad();

        if (deleteOriginal) {
            const currentChatNow = ctx.chat;
            for (const index of [...indices].sort((a, b) => b - a)) {
                if (index < currentChatNow.length) {
                    currentChatNow.splice(index, 1);
                }
            }
            await ctx.saveChat();
            await ctx.reloadCurrentChat();
        }

        const action = deleteOriginal ? '이동' : '복사';
        toastr.success(`${messagesToCopy.length}개 메시지를 ${action}했습니다.`);

    } catch (error) {
        console.error('[Broadcast] Error copying messages:', error);
        toastr.error(`메시지 처리 실패: ${error.message}`);

        try {
            await ctx.openCharacterChat(currentFileId);
        } catch (e) {
            console.error('[Broadcast] Failed to return to original chat:', e);
        }
    }
}

function waitForChatLoad() {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 20;

        const checkInterval = setInterval(() => {
            attempts++;
            if (!$('#chat').hasClass('loading') && $('#chat .mes').length >= 0) {
                clearInterval(checkInterval);
                setTimeout(resolve, 500);
                return;
            }

            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 300);
    });
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${url} ${response.status} ${text}`.trim());
    }
    return response.json().catch(() => ({}));
}

async function readChatFile(avatar, fileName) {
    const data = await postJson('/api/chats/get', { avatar_url: avatar, file_name: fileName });
    return Array.isArray(data) ? data : [];
}

async function moveCollectedMessages(indices) {
    const s = extension_settings[extensionName];
    const ctx = getContext();
    const character = ctx.characters[ctx.characterId];
    if (!character) throw new Error('현재 캐릭터를 찾을 수 없어요');

    const avatar = character.avatar;
    const currentFileId = removeJsonlExtension(character.chat);
    let fileName = resolveMoveName(s.moveName);
    if (!fileName) throw new Error('파일 이름이 비어 있어요');
    if (fileName === currentFileId) throw new Error(`지금 채팅과 같은 이름("${fileName}")이라 옮기지 않았어요`);

    const sorted = [...new Set(indices)].filter(i => i >= 0 && i < ctx.chat.length).sort((a, b) => a - b);
    if (!sorted.length) return { count: 0, fileName };

    const messages = sorted.map(i => {
        const copy = structuredClone(ctx.chat[i]);
        if (s.moveUnhide) copy.is_system = false;
        return copy;
    });

    let existing = await readChatFile(avatar, fileName);
    if (s.moveMode === 'new' && existing.length > 0) {

        const base = fileName;
        for (let n = 2; n < 100; n++) {
            const candidate = `${base} (${n})`;
            if (candidate === currentFileId) continue;
            const found = await readChatFile(avatar, candidate);
            if (found.length === 0) {
                fileName = candidate;
                existing = [];
                break;
            }
        }
        if (existing.length > 0) throw new Error(`"${base}" 이름이 너무 많이 쓰였어요`);
    }

    const header = existing.length > 0 && existing[0] && !('mes' in existing[0])
        ? existing[0]
        : { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
    const body = existing.length > 0 ? existing.slice(header === existing[0] ? 1 : 0) : [];
    const chatData = [header, ...body, ...messages];

    await postJson('/api/chats/save', { avatar_url: avatar, file_name: fileName, chat: chatData });

    if (s.moveOriginal === 'delete') {
        const liveChat = getContext().chat;
        for (const index of [...sorted].sort((a, b) => b - a)) {
            if (index < liveChat.length) liveChat.splice(index, 1);
        }
        await ctx.saveChat();
        await ctx.reloadCurrentChat();
        await sleep(800);
        await waitForChatLoad();
    }

    return { count: messages.length, fileName };
}

let progress = null;

function showBroadcastControlPanel() {
    hideControlPanel();

    const panelHtml = `
        <div id="broadcast-control-panel" class="bcx-cp">
            <div class="bcx-cp-h">
                <b>📢 보내는 중</b>
                <span class="bcx-cp-pct" id="broadcast-progress-text">0%</span>
                <button type="button" class="bcx-cp-fold" id="broadcast-fold-btn" title="접기">접기 ▾</button>
            </div>
            <div class="bcx-cp-track"><div class="bcx-cp-fill" id="broadcast-progress-bar"></div></div>
            <div class="bcx-cp-list" id="broadcast-status"></div>
            <div class="bcx-cp-ac">
                <button type="button" class="bcx-b bcx-b--ghost" id="broadcast-pause-btn">⏸ 일시정지</button>
                <button type="button" class="bcx-b bcx-b--ghost" id="broadcast-edit-btn">✏️ 수정</button>
                <button type="button" class="bcx-b bcx-b--ghost" id="broadcast-stop-btn">⏹ 중지</button>
            </div>
        </div>
        <button type="button" id="broadcast-mini" class="bcx-mini" title="진행 창 펼치기">
            <span class="bcx-mini-ring" id="broadcast-mini-ring"></span>
            <span class="bcx-mini-t" id="broadcast-mini-text">📢 0/0</span>
            <span class="bcx-mini-up">▴</span>
        </button>
    `;

    const dockHost = isMobileUI() ? document.getElementById('form_sheld') : null;
    if (dockHost) {
        $(dockHost).prepend(panelHtml);
        $('#broadcast-control-panel, #broadcast-mini').addClass('bcx-docked');
    } else {
        $('body').append(panelHtml);
    }
    setPanelCollapsed(isMobileUI());

    $('#broadcast-fold-btn').on('click', () => setPanelCollapsed(true));
    $('#broadcast-mini').on('click', () => setPanelCollapsed(false));

    $('#broadcast-pause-btn').on('click', function() {
        isPaused = !isPaused;
        $(this).html(isPaused ? '▶️ 계속' : '⏸ 일시정지');
        renderProgress();
    });

    $('#broadcast-stop-btn').on('click', async function() {
        const confirmed = await bcxCallPopup('브로드캐스트를 중지하시겠습니까?', 'confirm', '', { okButton: '중지', cancelButton: '취소' });
        if (confirmed) {
            shouldStop = true;
            isPaused = false;
            renderProgress('⏹ 중지 중…');
        }
    });

    $('#broadcast-edit-btn').on('click', async function() {
        isPaused = true;
        $('#broadcast-pause-btn').html('▶️ 계속');
        renderProgress();
        await openMessageEditPopup();
    });
}

function setPanelCollapsed(collapsed) {
    if (progress) progress.collapsed = collapsed;
    $('#broadcast-control-panel').toggle(!collapsed);
    $('#broadcast-mini').toggle(!!collapsed);
}

async function openMessageEditPopup() {
    const body = `
        <section class="bcx-card">
            <small class="bcx-hint" style="margin:0 0 10px">저장하고 ▶️ 계속을 누르면 남은 메시지·캐릭터에 고친 내용이 나가요.</small>
            ${currentBroadcastMessages.map((msg, idx) => `
                <div class="bcx-msg">
                    <span class="bcx-num">${idx + 1}</span>
                    <textarea class="bcx-ta edit-broadcast-message" data-msg-index="${idx}" rows="2">${escapeAttr(msg)}</textarea>
                </div>`).join('')}
        </section>`;

    const result = await bcxModal({
        title: '✏️ 메시지 수정',
        size: 'md',
        okText: '저장',
        body,
        onOk(root) {
            $(root).find('.edit-broadcast-message').each(function () {
                const idx = parseInt($(this).data('msg-index'), 10);
                currentBroadcastMessages[idx] = $(this).val().trim();
            });
            return true;
        },
    });

    if (result) toastr.success('메시지가 수정되었습니다. ▶️ 계속을 눌러주세요.');
    renderProgress();
}

function renderProgress(note) {
    if (!progress) return;
    if (note !== undefined) {
        const cur = progress.chars[currentCharIndex];
        if (cur) cur.note = note;
    }

    const totalMsgs = Math.max(1, progress.totalMsgs);
    const perChar = (c) => totalMsgs + (c.move ? 1 : 0);
    const total = progress.chars.reduce((a, c) => a + perChar(c), 0);
    const doneSteps = progress.chars.reduce((a, c) => {
        if (c.status === 'done' || c.status === 'fail' || c.status === 'skip') return a + perChar(c);
        if (c.status === 'cur') return a + Math.min(c.sent || 0, totalMsgs) + (c.moved ? 1 : 0);
        return a;
    }, 0);
    const pct = total ? Math.round(doneSteps / total * 100) : 0;
    const curIdx = progress.chars.findIndex(c => c.status === 'cur');

    $('#broadcast-progress-text').text(`${pct}%`);
    $('#broadcast-progress-bar').css('width', `${pct}%`);
    $('#broadcast-mini-ring').css('--p', pct);
    const curChar = progress.chars[curIdx];
    $('#broadcast-mini-text').text(`📢 ${Math.max(curIdx, 0) + 1}/${progress.chars.length} · ${pct}%${isPaused ? ' · ⏸' : ''}${curChar?.moving ? ' · 📦' : ''}`);

    const rows = progress.chars.map((c) => {
        const av = c.isGroup
            ? '<span class="bcx-av bcx-av--sm bcx-av--grp">👥</span>'
            : `<img class="bcx-av bcx-av--sm" src="/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}" alt="">`;
        let st = '대기';
        if (c.status === 'done') st = `✓ 완료${c.movedTo ? ` · 📦 ${escapeAttr(c.movedTo)}` : ''}`;
        if (c.status === 'fail') st = `⚠ ${escapeAttr(c.note || '실패')}`;
        if (c.status === 'skip') st = '건너뜀';
        if (c.status === 'wait' && c.move) st = '대기 · 📦';
        if (c.status !== 'cur') {
            return `<div class="bcx-li is-${c.status}">${av}<span class="bcx-li-n">${escapeAttr(c.name)}</span><span class="bcx-li-s">${st}</span></div>`;
        }
        const chips = Array.from({ length: totalMsgs }, (_, i) => {
            const cls = i < (c.sent || 0) ? 'd' : (i === (c.sent || 0) && !c.moving ? 'n' : '');
            return `<i class="${cls}">${i + 1}${i < (c.sent || 0) ? ' ✓' : ''}</i>`;
        }).join('');
        const moveChip = c.move ? `<i class="mv ${c.moving ? 'n' : ''}">📦 → ${escapeAttr(c.moveName || '')}</i>` : '';
        return `
            <div class="bcx-li is-cur">
                <div class="bcx-li-top">${av}<b class="bcx-li-n">${escapeAttr(c.name)}</b><span class="bcx-li-s">${isPaused ? '⏸ 일시정지' : escapeAttr(c.note || '')}</span></div>
                <div class="bcx-li-steps">${chips}${moveChip}</div>
            </div>`;
    }).join('');

    $('#broadcast-status').html(rows);
}

function hideControlPanel() {
    $('#broadcast-control-panel').remove();
    $('#broadcast-mini').remove();
}

async function broadcastMessage(messages, autoHide) {
    if (isProcessing) {
        toastr.warning('이미 진행 중입니다.');
        return;
    }

    isProcessing = true;
    isPaused = false;
    shouldStop = false;
    currentBroadcastMessages = [...messages];
    currentCharIndex = 0;
    currentMessageIndex = 0;

    const totalChars = selectedChats.length;
    const totalMsgs = messages.length;
    const expectedPersona = extension_settings[extensionName].expectedPersona;
    const moveNamePreview = resolveMoveName(extension_settings[extensionName].moveName);

    progress = {
        totalMsgs,
        collapsed: false,
        chars: selectedChats.map(c => ({ ...c, status: 'wait', sent: 0, moveName: moveNamePreview })),
    };

    showBroadcastControlPanel();
    renderProgress();

    toastr.info(`${totalChars}명에게 각 ${totalMsgs}개 메시지 전송을 시작합니다...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < selectedChats.length; i++) {
        if (shouldStop) {
            toastr.warning('브로드캐스트가 중지되었습니다.');
            break;
        }

        currentCharIndex = i;
        const chatInfo = selectedChats[i];
        const state = progress.chars[i];
        state.status = 'cur';
        const collected = [];

        try {
            renderProgress('채팅으로 이동 중…');
            await switchToChat(chatInfo);

            const verified = await verifyCurrentChat(chatInfo.name, expectedPersona);
            if (!verified) {
                toastr.error(`${chatInfo.name}: 채팅 전환 검증 실패, 스킵합니다`);
                state.status = 'fail';
                state.note = '채팅 전환 실패';
                renderProgress();
                failCount++;
                continue;
            }

            for (let j = 0; j < currentBroadcastMessages.length; j++) {
                if (shouldStop) break;

                while (isPaused && !shouldStop) {
                    await sleep(500);
                }
                if (shouldStop) break;

                currentMessageIndex = j;
                const message = currentBroadcastMessages[j];

                if (!message) {
                    state.sent = j + 1;
                    continue;
                }

                renderProgress(`메시지 ${j + 1} 보내는 중…`);

                const msgCountBefore = getContext().chat.length;

                $('#send_textarea').val(message);
                $('#send_but').trigger('click');

                renderProgress(`메시지 ${j + 1} 답 기다리는 중…`);
                await waitForResponseComplete(600000, (phase) => {
                    if (phase === 'image') renderProgress(`메시지 ${j + 1} 이미지 기다리는 중…`);
                });

                await sleep(1000);

                const msgCountAfter = getContext().chat.length;
                if (msgCountAfter > msgCountBefore) {
                    const hideStart = msgCountBefore;
                    const hideEnd = msgCountAfter - 1;
                    for (let k = hideStart; k <= hideEnd; k++) collected.push(k);

                    if (autoHide) {
                        renderProgress(`메시지 ${j + 1} 숨기는 중…`);
                        await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                        await sleep(500);

                        const chat = getContext().chat;
                        const allHidden = chat.slice(hideStart, hideEnd + 1).every(m => m.is_system);
                        if (!allHidden) {
                            await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                            await sleep(500);
                        }
                    }
                }

                state.sent = j + 1;
                renderProgress();
            }

            if (!shouldStop && chatInfo.move && collected.length) {
                state.moving = true;
                renderProgress(`숨긴 ${collected.length}개 옮기는 중…`);
                try {
                    const moved = await moveCollectedMessages(collected);
                    state.movedTo = moved.fileName;
                    state.moveName = moved.fileName;
                    toastr.success(`📦 ${chatInfo.name}: ${moved.count}개 → "${moved.fileName}"`);
                } catch (moveError) {
                    console.error(`[Broadcast] Move failed: ${chatInfo.name}`, moveError);
                    toastr.error(`📦 옮기기 실패: ${chatInfo.name} - ${moveError.message}`);
                    state.movedTo = '실패(원래 채팅에 남음)';
                }
                state.moving = false;
                state.moved = true;
            }

            if (!shouldStop) {
                successCount++;
                state.status = 'done';
                state.note = '';
                renderProgress();
            }

            if (i < selectedChats.length - 1 && !shouldStop) {
                await sleep(1500);
            }

        } catch (error) {
            console.error(`[Broadcast] Failed: ${chatInfo.name}`, error);
            failCount++;
            state.status = 'fail';
            state.note = error.message;
            renderProgress();
            toastr.error(`실패: ${chatInfo.name} - ${error.message}`);
        }
    }

    isProcessing = false;
    hideControlPanel();
    progress = null;

    if (shouldStop) {
        toastr.warning(`브로드캐스트 중지됨. 성공: ${successCount}, 실패: ${failCount}`);
    } else if (failCount > 0) {
        toastr.warning(`전송 완료! 성공: ${successCount}, 실패: ${failCount}`);
    } else {
        toastr.success(`🎉 전송 완료! ${successCount}명 모두 성공!`);
    }
}

async function switchToChat(chatInfo) {
    const ctx = getContext();

    if (chatInfo.isGroup && chatInfo.grid) {
        const element = $(`.group_select[grid="${chatInfo.grid}"]`);
        if (element.length > 0) {
            element.trigger('click');
            await sleep(3000);
            await waitForChatLoad();
        } else {
            throw new Error(`Group not found: ${chatInfo.name}`);
        }
    } else {
        const characterIndex = chatInfo.avatar
            ? ctx.characters.findIndex(c => c.avatar === chatInfo.avatar)
            : ctx.characters.findIndex(c => c.name === chatInfo.name);

        if (characterIndex >= 0) {
            await ctx.selectCharacterById(characterIndex);
            await waitForCharacterSwitch(characterIndex);
        } else {
            throw new Error(`Character not found: ${chatInfo.name}`);
        }
    }
}

function waitForCharacterSwitch(targetId) {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 30;

        const checkInterval = setInterval(() => {
            attempts++;
            const currentId = getContext().characterId;

            if (String(currentId) === String(targetId)) {
                clearInterval(checkInterval);
                setTimeout(resolve, 1500);
                return;
            }

            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
    });
}

async function verifyCurrentChat(expectedCharName, expectedPersona) {
    const ctx = getContext();

    let currentCharName = '';

    if (ctx.groupId) {
        const groups = ctx.groups || [];
        const currentGroup = groups.find(g => g.id === ctx.groupId);
        currentCharName = currentGroup?.name || '';
    } else if (ctx.characterId !== undefined && ctx.characters) {
        const currentChar = ctx.characters[ctx.characterId];
        currentCharName = currentChar?.name || '';
    }

    const normalizedExpected = expectedCharName.trim().toLowerCase();
    const normalizedCurrent = currentCharName.trim().toLowerCase();

    if (normalizedExpected !== normalizedCurrent) {
        return false;
    }

    if (expectedPersona && expectedPersona.trim()) {
        const currentPersona = ctx.name1 || '';
        const normalizedExpectedPersona = expectedPersona.trim().toLowerCase();
        const normalizedCurrentPersona = currentPersona.trim().toLowerCase();

        if (normalizedExpectedPersona !== normalizedCurrentPersona) {
            toastr.error(`페르소나 불일치: ${expectedPersona} ≠ ${currentPersona}`);
            return false;
        }
    }

    return true;
}

function isTextGenerating() {
    return document.body.dataset.generating === 'true' || $('#mes_stop').is(':visible');
}

function isImageGenerating() {
    if (document.querySelector('.action-loader-toast[data-slug^="sd"]')) return true;
    return $('.toast .toast-message').filter(function () {
        const t = $(this).text();
        return /Generating.*images?/i.test(t) || /Generating an image/i.test(t);
    }).length > 0;
}

async function waitUntil(check, timeoutMs) {
    const started = Date.now();
    while (!check()) {
        if (shouldStop || Date.now() - started > timeoutMs) return false;
        await sleep(300);
    }
    return true;
}

async function waitForResponseComplete(maxWait = 600000, onPhase = () => {}) {
    const started = Date.now();
    const left = () => Math.max(0, maxWait - (Date.now() - started));

    await waitUntil(() => isTextGenerating(), 15000);

    onPhase('text');
    await waitUntil(() => !isTextGenerating(), left());

    const graceEnd = Date.now() + 3000;
    let sawImage = false;
    while (Date.now() < graceEnd && !shouldStop) {
        if (isImageGenerating()) {
            sawImage = true;
            break;
        }
        await sleep(300);
    }

    if (sawImage) {
        onPhase('image');
        while (!shouldStop && left() > 0) {
            await waitUntil(() => !isImageGenerating(), left());
            await sleep(1500);
            if (!isImageGenerating()) break;
        }
    }

    return left() > 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let isSimulating = false;
let simulTargetFileId = null;
let simulTargetIsNew = false;
let simulTargetNewName = '';
let simulCollectedMessages = [];
let simulOriginalChatFileId = null;

async function openSimulFileSelector() {
    if (isSimulating) {
        toastr.warning('이미 시뮬레이션이 진행 중입니다.');
        return;
    }

    const ctx = getContext();
    const currentCharId = ctx.characterId;
    if (currentCharId === undefined) {
        toastr.error('캐릭터를 먼저 선택해주세요.');
        return;
    }

    const currentCharacter = ctx.characters[currentCharId];
    if (!currentCharacter) {
        toastr.error('현재 캐릭터를 찾을 수 없습니다.');
        return;
    }

    const currentChatFileId = removeJsonlExtension(currentCharacter.chat);

    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: currentCharacter.avatar,
                simple: true,
            }),
        });

        if (!response.ok) {
            throw new Error('채팅 목록을 가져올 수 없습니다.');
        }

        const chatFiles = await response.json();

        const popupContent = `
            <div class="bcx-pop bcx-pop--md">
                <h3 class="bcx-title">🧪 시뮬레이션 - 저장 파일 선택</h3>
                <p class="bcx-sub">시뮬 결과가 저장될 파일을 선택하세요 (현재 채팅은 유지됩니다)</p>

                <div class="bcx-list">
                    <label class="bcx-row bcx-row--new">
                        <input type="radio"
                               name="simul-target"
                               class="bcx-check simul-target-radio"
                               data-file-id="__NEW_FILE__"
                               data-is-new="true">
                        <span class="bcx-row-text">➕ 새 파일 생성</span>
                    </label>

                    <div class="bcx-newfile" id="simul-new-file-name-container" style="display:none;">
                        <label class="bcx-label" style="display:block; margin-bottom:6px;">새 파일 이름</label>
                        <input type="text" class="bcx-input" id="simul-new-file-name-input" placeholder="파일 이름 입력 (비워두면 자동 생성)">
                    </div>

                    ${chatFiles && chatFiles.length > 0 ? chatFiles.map((file) => {
                        const fileId = file.file_id || removeJsonlExtension(file.file_name);
                        const displayName = file.file_name || fileId;
                        const isCurrent = fileId === currentChatFileId;
                        return `
                            <label class="bcx-row">
                                <input type="radio"
                                       name="simul-target"
                                       class="bcx-check simul-target-radio"
                                       data-file-id="${fileId}"
                                       data-is-new="false">
                                <span class="bcx-row-text">${displayName}${isCurrent ? ' (현재)' : ''}</span>
                            </label>
                        `;
                    }).join('') : '<p class="bcx-empty">기존 채팅 파일이 없습니다. 새 파일을 생성하세요.</p>'}
                </div>
            </div>
        `;

        $(document).off('change', '.simul-target-radio').on('change', '.simul-target-radio', function () {
            const isNew = $(this).data('is-new') === true || $(this).data('is-new') === 'true';
            if (isNew) {
                $('#simul-new-file-name-container').slideDown(200);
                $('#simul-new-file-name-input').focus();
            } else {
                $('#simul-new-file-name-container').slideUp(200);
            }
        });

        const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '시작', cancelButton: '취소' });

        if (result) {
            const selectedRadio = $('.simul-target-radio:checked');
            const targetFileId = selectedRadio.data('file-id');
            const isNewFile = selectedRadio.data('is-new') === true || selectedRadio.data('is-new') === 'true';

            if (!targetFileId) {
                toastr.warning('대상 파일을 선택해주세요.');
                return;
            }

            simulOriginalChatFileId = currentChatFileId;
            simulTargetIsNew = isNewFile;
            simulTargetNewName = isNewFile ? ($('#simul-new-file-name-input').val().trim() || '') : '';
            simulTargetFileId = isNewFile ? null : targetFileId;
            simulCollectedMessages = [];

            showSimulPanel();
        }
    } catch (error) {
        console.error('[Broadcast] Simul file selector error:', error);
        toastr.error('파일 목록 가져오기 실패: ' + error.message);
    }
}

function showSimulPanel() {
    isSimulating = true;
    $('#simul-panel').remove();

    const panelHtml = `
        <div id="simul-panel">
            <div class="simul-panel-header">
                <span class="simul-panel-title">🧪 시뮬레이션</span>
                <span class="simul-msg-count" id="simul-msg-count">0건</span>
                <button id="simul-close-btn" class="menu_button simul-header-btn" title="종료">✕</button>
            </div>
            <div id="simul-response-area">
                <div class="simul-placeholder">메시지를 입력하고 전송하면 응답이 여기에 표시됩니다.<br><small style="opacity:0.6;">현재 채팅에서 전송되고, 결과는 선택한 파일에 저장됩니다.</small></div>
            </div>
            <div class="simul-input-area">
                <textarea id="simul-message-input" rows="3" placeholder="메시지를 입력하세요... (Ctrl+Enter로 전송)"></textarea>
                <div class="simul-input-actions">
                    <button id="simul-send-btn" class="menu_button simul-send-btn">전송</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(panelHtml);
    pinToViewport(document.getElementById('simul-panel'), 'fill');

    $('#simul-send-btn').on('click', handleSimulSend);
    $('#simul-message-input').on('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') {
            handleSimulSend();
        }
    });

    $('#simul-close-btn').on('click', async function () {
        const msgInfo = simulCollectedMessages.length > 0
            ? `\n\n수집된 ${simulCollectedMessages.length}건의 메시지를 선택한 파일에 저장합니다.`
            : '';
        const confirmed = await bcxCallPopup(`시뮬레이션을 종료하시겠습니까?${msgInfo}`, 'confirm', '', { okButton: '종료 및 저장', cancelButton: '취소' });
        if (confirmed) {
            await saveSimulMessages();
            closeSimulPanel();
        }
    });
}

async function handleSimulSend() {
    const message = $('#simul-message-input').val().trim();
    if (!message) {
        toastr.warning('메시지를 입력해주세요.');
        return;
    }

    $('#simul-send-btn').prop('disabled', true).text('전송 중...');
    $('#simul-message-input').prop('disabled', true);

    const responseArea = $('#simul-response-area');
    responseArea.find('.simul-placeholder').remove();

    const userMsgHtml = `
        <div class="simul-message simul-message-user">
            <div class="simul-message-sender">📝 나</div>
            <div class="simul-message-content">${escapeHtml(message)}</div>
        </div>
    `;
    responseArea.append(userMsgHtml);

    const waitingHtml = `<div class="simul-message simul-message-char" id="simul-waiting">
        <div class="simul-message-sender">💬 응답 대기 중...</div>
        <div class="simul-message-content simul-typing">...</div>
    </div>`;
    responseArea.append(waitingHtml);
    responseArea.scrollTop(responseArea[0].scrollHeight);

    const msgCountBefore = getContext().chat.length;

    $('#send_textarea').val(message);
    $('#send_but').trigger('click');

    $('#simul-message-input').val('');

    await waitForResponseComplete();
    await sleep(500);

    const currentChat = getContext().chat;
    $('#simul-waiting').remove();

    if (currentChat.length > msgCountBefore) {
        for (let i = msgCountBefore; i < currentChat.length; i++) {
            const msg = currentChat[i];
            simulCollectedMessages.push(JSON.parse(JSON.stringify(msg)));

            if (msg.is_user) {

                continue;
            }

            const charMsgHtml = `
                <div class="simul-message simul-message-char">
                    <div class="simul-message-sender">💬 ${escapeHtml(msg.name || 'Character')}</div>
                    <div class="simul-message-content">${formatSimulResponse(msg.mes || '')}</div>
                </div>
            `;
            responseArea.append(charMsgHtml);
        }

        const hideStart = msgCountBefore;
        const hideEnd = currentChat.length - 1;
        try {
            await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
            await sleep(300);
            const allHidden = currentChat.slice(hideStart, hideEnd + 1).every(m => m.is_hidden);
            if (!allHidden) {
                await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
            }
        } catch (e) {
            console.warn('[Broadcast] Simul hide error:', e);
        }
    } else {
        responseArea.append(`
            <div class="simul-message simul-message-char">
                <div class="simul-message-sender">⚠️ 시스템</div>
                <div class="simul-message-content">응답을 받지 못했습니다.</div>
            </div>
        `);
    }

    $('#simul-msg-count').text(`${simulCollectedMessages.length}건`);
    responseArea.scrollTop(responseArea[0].scrollHeight);

    $('#simul-send-btn').prop('disabled', false).text('전송');
    $('#simul-message-input').prop('disabled', false).focus();
}

async function saveSimulMessages() {
    if (simulCollectedMessages.length === 0) {
        toastr.info('저장할 시뮬 메시지가 없습니다.');
        return;
    }

    const ctx = getContext();

    try {
        toastr.info('시뮬 결과 저장 중...');

        if (simulTargetIsNew) {

            await executeSlashCommands('/newchat');
            await sleep(2000);
            await waitForChatLoad();

            if (simulTargetNewName) {
                try {
                    await executeSlashCommands(`/renamechat ${simulTargetNewName}`);
                    await sleep(500);
                } catch (e) {
                    console.warn('[Broadcast] Simul rename error:', e);
                }
            }

            const newChat = ctx.chat;
            for (const msg of simulCollectedMessages) {
                newChat.push(msg);
            }
            await ctx.saveChat();
            await sleep(500);

            await ctx.openCharacterChat(simulOriginalChatFileId);
            await sleep(2000);
            await waitForChatLoad();
        } else {

            await ctx.openCharacterChat(simulTargetFileId);
            await sleep(2000);
            await waitForChatLoad();

            const targetChat = ctx.chat;
            for (const msg of simulCollectedMessages) {
                targetChat.push(msg);
            }
            await ctx.saveChat();
            await sleep(500);

            await ctx.openCharacterChat(simulOriginalChatFileId);
            await sleep(2000);
            await waitForChatLoad();
        }

        toastr.success(`${simulCollectedMessages.length}건의 시뮬 메시지가 저장되었습니다.`);
    } catch (error) {
        console.error('[Broadcast] Simul save error:', error);
        toastr.error('시뮬 결과 저장 실패: ' + error.message);

        try {
            await ctx.openCharacterChat(simulOriginalChatFileId);
        } catch (e) {
            console.error('[Broadcast] Failed to return to original chat:', e);
        }
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatSimulResponse(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function closeSimulPanel() {
    isSimulating = false;
    simulCollectedMessages = [];
    simulTargetFileId = null;
    simulTargetIsNew = false;
    simulTargetNewName = '';
    simulOriginalChatFileId = null;
    const el = document.getElementById('simul-panel');
    if (el) unpinFromViewport(el);
    $('#simul-panel').remove();
    toastr.info('시뮬레이션이 종료되었습니다.');
}

function addMenuButtons() {
    $('#broadcast_wand_container').remove();

    const buttonHtml = `
        <div id="broadcast_wand_container" class="extension_container interactable" tabindex="0">
            <div id="broadcast-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" style="display:${extension_settings[extensionName].showBroadcastBtn ? 'flex' : 'none'}">
                <div class="fa-solid fa-bullhorn extensionsMenuExtensionButton"></div>
                <span>브로드캐스트</span>
            </div>
            <div id="hide-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" style="display:${extension_settings[extensionName].showHideBtn ? 'flex' : 'none'}">
                <div class="fa-solid fa-eye-slash extensionsMenuExtensionButton"></div>
                <span>메시지 숨기기</span>
            </div>
            <div id="backup-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" style="display:${extension_settings[extensionName].showBackupBtn ? 'flex' : 'none'}">
                <div class="fa-solid fa-box-archive extensionsMenuExtensionButton"></div>
                <span>백업</span>
            </div>
        </div>
    `;

    $('#extensionsMenu').prepend(buttonHtml);

    $('#broadcast-btn').on('click', openChatSelector);
    $('#hide-btn').on('click', openHideModal);
    $('#backup-btn').on('click', openBackupModal);
}

jQuery(async () => {
    loadSettings();
    createSettingsUI();

    setTimeout(() => {
        addMenuButtons();
    }, 1000);
});
