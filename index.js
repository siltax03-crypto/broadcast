import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';

const getContext = () => SillyTavern.getContext();
const getCallPopup = () => getContext().callPopup;
const executeSlashCommands = (cmd) => getContext().executeSlashCommands(cmd);

/**
 * callPopup 래퍼. 이 ST의 callPopup 은 구형 #dialogue_popup 을 재사용하고
 * 버튼은 #dialogue_popup_ok / #dialogue_popup_cancel (.menu_button div) 이다.
 * 우리 팝업이 떠 있는 동안만 그 버튼에 전용 클래스를 심어서(닫히면 제거)
 * ST 기본 .menu_button 회색·세로뭉갬을 우리 클래스로 덮고, 다른 ST 팝업엔 영향 없게 한다.
 */
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
    // 렌더 타이밍 편차 대비해 두어 번 심는다
    requestAnimationFrame(() => bcxStampDialogueButtons(true));
    setTimeout(() => bcxStampDialogueButtons(true), 0);
    setTimeout(() => bcxStampDialogueButtons(true), 50);
    // 닫히면(프라미스 resolve) 원복
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
};

let isProcessing = false;
let isPaused = false;
let shouldStop = false;
let selectedChats = [];
let currentBroadcastMessages = [];
let currentMessageIndex = 0;
let currentCharIndex = 0;
let lastCheckedBackupIndex = null;

// ==================== 모바일/뷰포트 유틸 ====================

const MOBILE_QUERY = '(max-width: 520px)';
const pinnedPanels = new Map();

function isMobileUI() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * fixed 패널을 실제 보이는 영역(visualViewport)에 고정한다.
 * 모바일 키보드가 올라와도 패널이 화면 밖으로 밀리지 않는다.
 * 데스크톱 폭에서는 인라인 좌표를 지워 CSS 배치로 되돌린다.
 */
function pinToViewport(el, mode = 'fill') {
    if (!el) return;
    const vv = window.visualViewport;

    const apply = () => {
        if (!el.isConnected) return unpinFromViewport(el);

        if (!vv || !isMobileUI()) {
            el.style.top = el.style.left = el.style.right = el.style.bottom = '';
            el.style.width = el.style.height = '';
            return;
        }

        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = `${vv.offsetLeft}px`;
        el.style.width = `${vv.width}px`;

        if (mode === 'fill') {
            el.style.top = `${vv.offsetTop}px`;
            el.style.height = `${vv.height}px`;
        } else {
            // 'dock': 보이는 영역 하단에 붙인다
            el.style.height = '';
            el.style.left = `${vv.offsetLeft + 8}px`;
            el.style.width = `${vv.width - 16}px`;
            el.style.top = `${vv.offsetTop + vv.height - el.offsetHeight - 8}px`;
        }
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

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
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
    
    const savedMessageCount = extension_settings[extensionName].messageCount || 1;
    
    const popupContent = `
        <div class="bcx-pop bcx-pop--lg">
            <h3 class="bcx-title">📢 브로드캐스트 메시지</h3>

            <div class="bcx-list">
                <label class="bcx-row bcx-row--head">
                    <input type="checkbox" class="bcx-check" id="broadcast-select-all">
                    <span>전체 선택</span>
                </label>
                ${chats.map((chatItem, index) => `
                    <label class="bcx-row">
                        <input type="checkbox"
                               class="bcx-check broadcast-chat-checkbox"
                               data-index="${index}"
                               data-chid="${chatItem.chid || ''}"
                               data-grid="${chatItem.grid || ''}"
                               data-name="${chatItem.name}"
                               data-is-group="${chatItem.isGroup || false}">
                        <span class="bcx-row-text">${chatItem.isGroup ? '👥 ' : ''}${chatItem.name}</span>
                    </label>
                `).join('')}
            </div>

            <div class="bcx-field">
                <label class="bcx-label">캐릭터당 메시지 개수</label>
                <input type="number" class="bcx-input" id="broadcast-message-count" min="1" max="10" value="${savedMessageCount}">
                <small class="bcx-hint">각 캐릭터에서 순차적으로 N개 메시지를 보내고 각각 숨김 처리합니다</small>
            </div>

            <div class="bcx-field" id="broadcast-messages-container">
                <label class="bcx-label">보낼 메시지</label>
                <div class="bcx-stack" id="broadcast-message-inputs">
                    <textarea class="bcx-textarea broadcast-message-input" data-msg-index="0" rows="2" placeholder="메시지 1"></textarea>
                </div>
            </div>

            <label class="bcx-inline-label">
                <input type="checkbox" class="bcx-check" id="broadcast-auto-hide" ${extension_settings[extensionName].autoHide ? 'checked' : ''}>
                <span>보낸 메시지와 응답 자동 숨김</span>
            </label>
        </div>
    `;
    
    $(document).off('change', '#broadcast-select-all').on('change', '#broadcast-select-all', function() {
        $('.broadcast-chat-checkbox').prop('checked', this.checked);
    });
    
    $(document).off('change input', '#broadcast-message-count').on('change input', '#broadcast-message-count', function() {
        const count = parseInt($(this).val(), 10) || 1;
        updateMessageInputs(count);
    });
    
    const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '전송', cancelButton: '취소' });
    
    if (result) {
        const messageCount = parseInt($('#broadcast-message-count').val(), 10) || 1;
        const messages = [];
        
        $('.broadcast-message-input').each(function() {
            const msg = $(this).val().trim();
            if (msg) {
                messages.push(msg);
            }
        });
        
        const autoHide = $('#broadcast-auto-hide').is(':checked');
        
        if (messages.length === 0) {
            toastr.warning('최소 하나의 메시지를 입력해주세요.');
            return;
        }
        
        selectedChats = [];
        $('.broadcast-chat-checkbox:checked').each(function() {
            selectedChats.push({
                chid: $(this).data('chid'),
                grid: $(this).data('grid'),
                name: $(this).data('name'),
                isGroup: $(this).data('is-group') === true || $(this).data('is-group') === 'true',
            });
        });
        
        if (selectedChats.length === 0) {
            toastr.warning('최소 하나의 캐릭터를 선택해주세요.');
            return;
        }
        
        extension_settings[extensionName].autoHide = autoHide;
        extension_settings[extensionName].messageCount = messageCount;
        saveSettingsDebounced();
        
        await broadcastMessage(messages, autoHide);
    }
}

function updateMessageInputs(count) {
    const container = $('#broadcast-message-inputs');
    const currentInputs = container.find('.broadcast-message-input');
    const currentCount = currentInputs.length;
    
    const existingValues = [];
    currentInputs.each(function() {
        existingValues.push($(this).val());
    });
    
    if (count > currentCount) {
        for (let i = currentCount; i < count; i++) {
            container.append(`
                <textarea class="bcx-textarea broadcast-message-input" data-msg-index="${i}" rows="2"
                    placeholder="메시지 ${i + 1}"></textarea>
            `);
        }
    } else if (count < currentCount) {
        for (let i = currentCount - 1; i >= count; i--) {
            container.find(`.broadcast-message-input[data-msg-index="${i}"]`).remove();
        }
    }
}

async function openHideModal() {
    const popupContent = `
        <div class="bcx-pop bcx-pop--sm">
            <h3 class="bcx-title">🙈 메시지 숨기기</h3>

            <div class="bcx-field">
                <label class="bcx-label">숨길 메시지 개수</label>
                <input type="number" class="bcx-input" id="hide-count" min="1" max="100" value="2">
                <small class="bcx-hint">마지막 메시지부터 숨깁니다</small>
            </div>
        </div>
    `;
    
    const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '숨기기', cancelButton: '취소' });
    
    if (result) {
        const count = parseInt($('#hide-count').val(), 10);
        
        if (isNaN(count) || count < 1) {
            toastr.warning('올바른 숫자를 입력해주세요.');
            return;
        }
        
        await hideLastMessages(count);
    }
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
    
    const popupContent = `
        <div class="bcx-pop bcx-pop--xl">
            <h3 class="bcx-title">📦 메시지 백업</h3>

            <div class="bcx-field">
                <div class="bcx-range">
                    <button id="backup-select-range-btn" class="menu_button bcx-chip">📍 범위 선택</button>
                    <div class="bcx-range-box">
                        <input type="number" id="backup-range-start" placeholder="시작">
                        <span style="opacity:.6;">~</span>
                        <input type="number" id="backup-range-end" placeholder="끝">
                    </div>
                    <button id="backup-apply-range-btn" class="menu_button bcx-chip">✓ 적용</button>
                </div>
                <small class="bcx-hint" style="text-align:center;">💡 Shift+클릭 또는 인덱스 직접 입력</small>
            </div>

            <div class="bcx-list">
                <label class="bcx-row bcx-row--head">
                    <input type="checkbox" class="bcx-check" id="backup-select-all">
                    <span>전체 선택</span>
                </label>
                ${reversedChat.map((msg, displayIndex) => {
                    const realIndex = currentChat.length - 1 - displayIndex;
                    return `
                        <label class="bcx-row bcx-row--top" data-real-index="${realIndex}">
                            <input type="checkbox"
                                   class="bcx-check backup-msg-checkbox"
                                   data-index="${realIndex}"
                                   data-display-index="${displayIndex}">
                            <div class="bcx-row-text">
                                <div class="bcx-row-name ${msg.is_user ? 'is-user' : 'is-char'}">
                                    [${realIndex}] ${msg.name || (msg.is_user ? 'User' : 'Character')}
                                </div>
                                <div class="bcx-row-preview">
                                    ${(msg.mes || '').substring(0, 100)}${(msg.mes || '').length > 100 ? '...' : ''}
                                </div>
                            </div>
                        </label>
                    `;
                }).join('')}
            </div>

            <small class="bcx-hint">이동할 메시지를 선택하세요 (최신순)</small>
        </div>
    `;
    
    $(document).off('change', '#backup-select-all').on('change', '#backup-select-all', function() {
        $('.backup-msg-checkbox').prop('checked', this.checked);
    });
    
    $(document).off('click', '.backup-msg-checkbox').on('click', '.backup-msg-checkbox', function(e) {
        const currentIndex = parseInt($(this).data('display-index'), 10);
        
        if (e.shiftKey && lastCheckedBackupIndex !== null) {
            const start = Math.min(lastCheckedBackupIndex, currentIndex);
            const end = Math.max(lastCheckedBackupIndex, currentIndex);
            const isChecked = $(this).prop('checked');
            
            $('.backup-msg-checkbox').each(function() {
                const idx = parseInt($(this).data('display-index'), 10);
                if (idx >= start && idx <= end) {
                    $(this).prop('checked', isChecked);
                }
            });
        }
        
        lastCheckedBackupIndex = currentIndex;
    });
    
    $(document).off('click', '#backup-apply-range-btn').on('click', '#backup-apply-range-btn', function() {
        const startIdx = parseInt($('#backup-range-start').val(), 10);
        const endIdx = parseInt($('#backup-range-end').val(), 10);
        
        if (isNaN(startIdx) || isNaN(endIdx)) {
            toastr.warning('시작과 끝 인덱스를 입력해주세요.');
            return;
        }
        
        const minIdx = Math.min(startIdx, endIdx);
        const maxIdx = Math.max(startIdx, endIdx);
        
        $('.backup-msg-checkbox').each(function() {
            const realIdx = parseInt($(this).data('index'), 10);
            if (realIdx >= minIdx && realIdx <= maxIdx) {
                $(this).prop('checked', true);
            }
        });
        
        toastr.success(`인덱스 ${minIdx}~${maxIdx} 범위 선택됨`);
    });
    
    const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '다음', cancelButton: '취소', wide: true });
    
    if (result) {
        const selectedIndices = [];
        $('.backup-msg-checkbox:checked').each(function() {
            selectedIndices.push(parseInt($(this).data('index'), 10));
        });
        
        if (selectedIndices.length === 0) {
            toastr.warning('최소 하나의 메시지를 선택해주세요.');
            return;
        }
        
        await openBackupTargetSelector(selectedIndices);
    }
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
    
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ 
                avatar_url: currentCharacter.avatar,
                simple: true 
            }),
        });
        
        if (!response.ok) {
            throw new Error('채팅 목록을 가져올 수 없습니다.');
        }
        
        const chatFiles = await response.json();
        
        const popupContent = `
            <div class="bcx-pop bcx-pop--md">
                <h3 class="bcx-title">📁 대상 채팅 파일 선택</h3>
                <p class="bcx-sub">${selectedIndices.length}개 메시지를 복사합니다</p>

                <div class="bcx-list">
                    <label class="bcx-row bcx-row--new">
                        <input type="radio"
                               name="backup-target"
                               class="bcx-check backup-target-radio"
                               data-file-id="__NEW_FILE__"
                               data-is-new="true">
                        <span class="bcx-row-text">➕ 새 파일 생성</span>
                    </label>

                    <div class="bcx-newfile" id="new-file-name-container" style="display:none;">
                        <label class="bcx-label" style="display:block; margin-bottom:6px;">새 파일 이름</label>
                        <input type="text" class="bcx-input" id="new-file-name-input" placeholder="파일 이름 입력 (비워두면 자동 생성)">
                    </div>

                    ${chatFiles && chatFiles.length > 0 ? chatFiles.map((file) => {
                        const fileId = file.file_id || removeJsonlExtension(file.file_name);
                        const displayName = file.file_name || fileId;
                        const isCurrent = fileId === currentChatFileId;
                        return `
                            <label class="bcx-row ${isCurrent ? 'bcx-row--disabled' : ''}">
                                <input type="radio"
                                       name="backup-target"
                                       class="bcx-check backup-target-radio"
                                       data-file-id="${fileId}"
                                       data-is-new="false"
                                       ${isCurrent ? 'disabled' : ''}>
                                <span class="bcx-row-text">${displayName}${isCurrent ? ' (현재)' : ''}</span>
                            </label>
                        `;
                    }).join('') : '<p class="bcx-empty">기존 채팅 파일이 없습니다. 새 파일을 생성하세요.</p>'}
                </div>

                <label class="bcx-inline-label">
                    <input type="checkbox" class="bcx-check" id="backup-delete-original">
                    <span>원본 메시지 삭제 (이동)</span>
                </label>
            </div>
        `;
        
        $(document).off('change', '.backup-target-radio').on('change', '.backup-target-radio', function() {
            const isNew = $(this).data('is-new') === true || $(this).data('is-new') === 'true';
            if (isNew) {
                $('#new-file-name-container').slideDown(200);
                $('#new-file-name-input').focus();
            } else {
                $('#new-file-name-container').slideUp(200);
            }
        });
        
        const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '실행', cancelButton: '취소' });
        
        if (result) {
            const selectedRadio = $('.backup-target-radio:checked');
            const targetFileId = selectedRadio.data('file-id');
            const isNewFile = selectedRadio.data('is-new') === true || selectedRadio.data('is-new') === 'true';
            const deleteOriginal = $('#backup-delete-original').is(':checked');
            
            if (!targetFileId) {
                toastr.warning('대상 채팅 파일을 선택해주세요.');
                return;
            }
            
            if (isNewFile) {
                const newFileName = $('#new-file-name-input').val().trim();
                await copyMessagesToNewFile(selectedIndices, newFileName, currentChatFileId, deleteOriginal);
            } else {
                await copyMessagesToFile(selectedIndices, targetFileId, currentChatFileId, deleteOriginal);
            }
        }
        
    } catch (error) {
        console.error('[Broadcast] Error getting chat files:', error);
        toastr.error('채팅 파일 목록을 가져오는데 실패했습니다: ' + error.message);
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

function showBroadcastControlPanel() {
    $('#broadcast-control-panel').remove();
    
    const panelHtml = `
        <div id="broadcast-control-panel">
            <div class="bcx-cp-top">
                <span>📢 브로드캐스트 진행 중</span>
                <span class="bcx-cp-count" id="broadcast-progress-text">0/0</span>
            </div>
            <div class="bcx-cp-status" id="broadcast-status">준비 중...</div>
            <div class="bcx-cp-track">
                <div class="bcx-cp-fill" id="broadcast-progress-bar"></div>
            </div>
            <div class="bcx-cp-actions">
                <button id="broadcast-pause-btn" class="menu_button">⏸️ 일시정지</button>
                <button id="broadcast-edit-btn" class="menu_button">✏️ 수정</button>
                <button id="broadcast-stop-btn" class="menu_button bcx-cp-stop">⏹️ 중지</button>
            </div>
        </div>
    `;

    $('body').append(panelHtml);
    pinToViewport(document.getElementById('broadcast-control-panel'), 'dock');

    $('#broadcast-pause-btn').on('click', function() {
        isPaused = !isPaused;
        $(this).html(isPaused ? '▶️ 계속' : '⏸️ 일시정지');
        $('#broadcast-status').text(isPaused ? '⏸️ 일시정지됨 - 계속하려면 클릭하세요' : '진행 중...');
    });
    
    $('#broadcast-stop-btn').on('click', async function() {
        const confirmed = await bcxCallPopup('브로드캐스트를 중지하시겠습니까?', 'confirm', '', { okButton: '중지', cancelButton: '취소' });
        if (confirmed) {
            shouldStop = true;
            isPaused = false;
            $('#broadcast-status').text('⏹️ 중지 중...');
        }
    });
    
    $('#broadcast-edit-btn').on('click', async function() {
        isPaused = true;
        $('#broadcast-pause-btn').html('▶️ 계속');
        
        await openMessageEditPopup();
    });
}

async function openMessageEditPopup() {
    const popupContent = `
        <div class="bcx-pop bcx-pop--md">
            <h3 class="bcx-title">✏️ 메시지 수정</h3>
            <small class="bcx-sub">수정 후 계속 진행하면 남은 캐릭터들에게 수정된 메시지가 전송됩니다</small>

            <div class="bcx-stack" id="edit-message-inputs">
                ${currentBroadcastMessages.map((msg, idx) => `
                    <div class="bcx-field">
                        <label class="bcx-label">메시지 ${idx + 1}${idx === currentMessageIndex ? ' (현재)' : ''}</label>
                        <textarea class="bcx-textarea edit-broadcast-message" data-msg-index="${idx}" rows="2">${msg}</textarea>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    
    const result = await bcxCallPopup(popupContent, 'confirm', '', { okButton: '저장 후 계속', cancelButton: '취소' });
    
    if (result) {
        $('.edit-broadcast-message').each(function() {
            const idx = parseInt($(this).data('msg-index'), 10);
            currentBroadcastMessages[idx] = $(this).val().trim();
        });
        
        toastr.success('메시지가 수정되었습니다. 계속 버튼을 눌러주세요.');
    }
    
    $('#broadcast-status').text('⏸️ 일시정지됨 - 계속하려면 클릭하세요');
}

function updateControlPanel(charIndex, msgIndex, totalChars, totalMsgs, charName, status) {
    const totalProgress = charIndex * totalMsgs + msgIndex;
    const totalSteps = totalChars * totalMsgs;
    const percent = totalSteps > 0 ? (totalProgress / totalSteps * 100) : 0;
    
    $('#broadcast-progress-text').text(`${charIndex + 1}/${totalChars} 캐릭터, ${msgIndex}/${totalMsgs} 메시지`);
    $('#broadcast-progress-bar').css('width', `${percent}%`);
    $('#broadcast-status').text(`${charName}: ${status}`);
}

function hideControlPanel() {
    const el = document.getElementById('broadcast-control-panel');
    if (el) unpinFromViewport(el);
    $('#broadcast-control-panel').remove();
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
    
    showBroadcastControlPanel();
    
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
        
        try {
            updateControlPanel(i, 0, totalChars, totalMsgs, chatInfo.name, '채팅으로 이동 중...');
            await switchToChat(chatInfo);
            
            const verified = await verifyCurrentChat(chatInfo.name, expectedPersona);
            if (!verified) {
                toastr.error(`${chatInfo.name}: 채팅 전환 검증 실패, 스킵합니다`);
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
                
                if (!message) continue;
                
                updateControlPanel(i, j + 1, totalChars, totalMsgs, chatInfo.name, `메시지 ${j + 1} 전송 중...`);
                
                const msgCountBefore = getContext().chat.length;
                
                $('#send_textarea').val(message);
                $('#send_but').trigger('click');
                
                updateControlPanel(i, j + 1, totalChars, totalMsgs, chatInfo.name, `응답 대기 중...`);
                await waitForResponseComplete();
                
                await sleep(1000);
                
                if (autoHide) {
                    const msgCountAfter = getContext().chat.length;
                    if (msgCountAfter > msgCountBefore) {
                        const hideStart = msgCountBefore;
                        const hideEnd = msgCountAfter - 1;
                        
                        updateControlPanel(i, j + 1, totalChars, totalMsgs, chatInfo.name, `메시지 숨김 처리 중...`);
                        await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                        await sleep(500);
                        
                        const chat = getContext().chat;
                        const allHidden = chat.slice(hideStart, hideEnd + 1).every(m => m.is_hidden);
                        if (!allHidden) {
                            await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                            await sleep(500);
                        }
                    }
                }
            }
            
            if (!shouldStop) {
                successCount++;
                toastr.success(`${successCount}/${totalChars} 완료: ${chatInfo.name}`);
            }
            
            if (i < selectedChats.length - 1 && !shouldStop) {
                await sleep(1500);
            }
            
        } catch (error) {
            console.error(`[Broadcast] Failed: ${chatInfo.name}`, error);
            failCount++;
            toastr.error(`실패: ${chatInfo.name} - ${error.message}`);
        }
    }
    
    isProcessing = false;
    hideControlPanel();
    
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
        const characterIndex = ctx.characters.findIndex(c => c.name === chatInfo.name);
        
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

function waitForResponseComplete(maxWait = 600000) {
    return new Promise((resolve) => {
        let elapsed = 0;
        const checkInterval = 500;
        let imageGenerating = false;
        let textResponseDone = false;
        
        setTimeout(() => {
            const interval = setInterval(() => {
                elapsed += checkInterval;
                
                const generatingToast = $('.toast-info .toast-message:contains("Generating")').length > 0 ||
                                        $('.toast-info .toast-message:contains("images")').length > 0;
                const successToast = $('.toast-success .toast-message:contains("generated successfully")').length > 0 ||
                                     $('.toast-success .toast-message:contains("images")').length > 0;
                
                if (generatingToast && !imageGenerating) {
                    imageGenerating = true;
                }
                
                const typingIndicator = document.getElementById('typing_indicator');
                const isGenerating = $('#send_but').hasClass('displayNone') || 
                                    $('#mes_stop').is(':visible') ||
                                    $('#chat').hasClass('loading');
                
                if (!typingIndicator && !isGenerating) {
                    textResponseDone = true;
                }
                
                if (imageGenerating) {
                    if (successToast) {
                        setTimeout(() => {
                            clearInterval(interval);
                            resolve(true);
                        }, 1500);
                        return;
                    }
                    return;
                }
                
                if (textResponseDone && !generatingToast) {
                    clearInterval(interval);
                    resolve(true);
                    return;
                }
                
                if (elapsed >= maxWait) {
                    clearInterval(interval);
                    resolve(false);
                }
            }, checkInterval);
        }, 1000);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 시뮬레이션 기능 ====================

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
                // 유저 메시지는 이미 위에 표시했으므로 스킵
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

        // 현재 채팅에서 시뮬 메시지 숨기기
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
            // 새 파일 생성 → 메시지 추가 → 원래 채팅으로 복귀
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

            // 원래 채팅으로 복귀
            await ctx.openCharacterChat(simulOriginalChatFileId);
            await sleep(2000);
            await waitForChatLoad();
        } else {
            // 기존 파일에 추가 → 원래 채팅으로 복귀
            await ctx.openCharacterChat(simulTargetFileId);
            await sleep(2000);
            await waitForChatLoad();

            const targetChat = ctx.chat;
            for (const msg of simulCollectedMessages) {
                targetChat.push(msg);
            }
            await ctx.saveChat();
            await sleep(500);

            // 원래 채팅으로 복귀
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

// ==================== 메뉴 버튼 ====================

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
