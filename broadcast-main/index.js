// Broadcast Message Extension for SillyTavern
// 여러 채팅에 동일한 메시지를 보내고 자동으로 숨김 처리

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';

// SillyTavern context에서 함수들 가져오기
const getContext = () => SillyTavern.getContext();
const getCallPopup = () => getContext().callPopup;
const executeSlashCommands = (cmd) => getContext().executeSlashCommands(cmd);

const extensionName = 'broadcast-message';

// 기본 설정
const defaultSettings = {
    autoHide: true,
    showBroadcastBtn: true,
    showHideBtn: true,
    showBackupBtn: true,
    expectedPersona: '', // 예상 페르소나 이름
};

// 상태 관리
let isProcessing = false;
let selectedChats = [];

/**
 * 설정 초기화
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
}

/**
 * 설정 UI 생성
 */
function createSettingsUI() {
    const settingsHtml = `
        <div class="broadcast-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>브로드캐스트 설정</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="broadcast-setting-item" style="margin: 10px 0;">
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                            <input type="checkbox" id="broadcast-show-broadcast-btn" ${extension_settings[extensionName].showBroadcastBtn ? 'checked' : ''}>
                            <span>브로드캐스트 버튼 표시</span>
                        </label>
                    </div>
                    <div class="broadcast-setting-item" style="margin: 10px 0;">
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                            <input type="checkbox" id="broadcast-show-hide-btn" ${extension_settings[extensionName].showHideBtn ? 'checked' : ''}>
                            <span>메시지 숨기기 버튼 표시</span>
                        </label>
                    </div>
                    <div class="broadcast-setting-item" style="margin: 10px 0;">
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                            <input type="checkbox" id="broadcast-show-backup-btn" ${extension_settings[extensionName].showBackupBtn ? 'checked' : ''}>
                            <span>백업 버튼 표시</span>
                        </label>
                    </div>
                    <div class="broadcast-setting-item" style="margin: 10px 0;">
                        <label style="display:block; margin-bottom:5px;">예상 페르소나 이름 (선택)</label>
                        <input type="text" id="broadcast-persona" value="${extension_settings[extensionName].expectedPersona || ''}" placeholder="페르소나 이름 입력 (비워두면 검증 안함)" style="width: 100%; padding: 5px;">
                        <small style="opacity:0.7; display:block; margin-top:3px;">브로드캐스트 시 페르소나가 맞는지 확인합니다</small>
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
    
    $('#broadcast-persona').on('change', function() {
        extension_settings[extensionName].expectedPersona = this.value.trim();
        saveSettingsDebounced();
    });
}

/**
 * 버튼 표시 여부 업데이트
 */
function updateButtonVisibility() {
    $('#broadcast-btn').toggle(extension_settings[extensionName].showBroadcastBtn);
    $('#hide-btn').toggle(extension_settings[extensionName].showHideBtn);
    $('#backup-btn').toggle(extension_settings[extensionName].showBackupBtn);
}

/**
 * 캐릭터 목록 가져오기
 */
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

/**
 * 브로드캐스트 UI 열기
 */
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
    
    const popupContent = `
        <div style="display:flex; flex-direction:column; gap:15px; min-width:400px;">
            <h3 style="margin:0; text-align:center;">📢 브로드캐스트 메시지</h3>
            
            <div style="max-height:200px; overflow-y:auto; border:1px solid var(--SmartThemeBorderColor); border-radius:5px; padding:10px; background:var(--SmartThemeBlurTintColor);">
                <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer; border-bottom:1px solid var(--SmartThemeBorderColor); margin-bottom:10px;">
                    <input type="checkbox" id="broadcast-select-all" style="width:18px; height:18px;">
                    <span style="font-weight:bold;">전체 선택</span>
                </label>
                ${chats.map((chatItem, index) => `
                    <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer;">
                        <input type="checkbox" 
                               class="broadcast-chat-checkbox" 
                               data-index="${index}"
                               data-chid="${chatItem.chid || ''}"
                               data-grid="${chatItem.grid || ''}"
                               data-name="${chatItem.name}"
                               data-is-group="${chatItem.isGroup || false}"
                               style="width:18px; height:18px;">
                        <span>${chatItem.isGroup ? '👥 ' : ''}${chatItem.name}</span>
                    </label>
                `).join('')}
            </div>
            
            <div>
                <label style="display:block; margin-bottom:5px;">보낼 메시지:</label>
                <textarea id="broadcast-message" rows="3" style="width:100%; padding:8px; border-radius:5px; border:1px solid var(--SmartThemeBorderColor); background:var(--SmartThemeBlurTintColor); color:var(--SmartThemeBodyColor); resize:vertical;" placeholder="여러 캐릭터에게 보낼 메시지를 입력하세요..."></textarea>
            </div>
            
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="broadcast-auto-hide" ${extension_settings[extensionName].autoHide ? 'checked' : ''} style="width:18px; height:18px;">
                <span>보낸 메시지와 응답 자동 숨김</span>
            </label>
        </div>
    `;
    
    $(document).off('change', '#broadcast-select-all').on('change', '#broadcast-select-all', function() {
        $('.broadcast-chat-checkbox').prop('checked', this.checked);
    });
    
    const result = await getCallPopup()(popupContent, 'confirm', '', { okButton: '전송', cancelButton: '취소' });
    
    if (result) {
        const message = $('#broadcast-message').val().trim();
        const autoHide = $('#broadcast-auto-hide').is(':checked');
        
        if (!message) {
            toastr.warning('메시지를 입력해주세요.');
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
        saveSettingsDebounced();
        
        await broadcastMessage(message, autoHide);
    }
}

/**
 * 하이드 모달 열기
 */
async function openHideModal() {
    const popupContent = `
        <div style="display:flex; flex-direction:column; gap:15px; min-width:300px;">
            <h3 style="margin:0; text-align:center;">🙈 메시지 숨기기</h3>
            
            <div>
                <label style="display:block; margin-bottom:5px;">숨길 메시지 개수:</label>
                <input type="number" id="hide-count" min="1" max="100" value="2" 
                       style="width:100%; padding:10px; border-radius:5px; border:1px solid var(--SmartThemeBorderColor); background:var(--SmartThemeBlurTintColor); color:var(--SmartThemeBodyColor); font-size:16px;">
                <small style="color:var(--SmartThemeBodyColor); opacity:0.7; margin-top:5px; display:block;">마지막 메시지부터 숨깁니다</small>
            </div>
        </div>
    `;
    
    const result = await getCallPopup()(popupContent, 'confirm', '', { okButton: '숨기기', cancelButton: '취소' });
    
    if (result) {
        const count = parseInt($('#hide-count').val(), 10);
        
        if (isNaN(count) || count < 1) {
            toastr.warning('올바른 숫자를 입력해주세요.');
            return;
        }
        
        await hideLastMessages(count);
    }
}

/**
 * 마지막 N개 메시지 숨기기
 */
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

/**
 * 백업 모달 열기 - 최신 메시지부터 표시
 */
async function openBackupModal() {
    const ctx = getContext();
    const currentChat = ctx.chat;
    
    if (!currentChat || currentChat.length === 0) {
        toastr.info('백업할 메시지가 없습니다.');
        return;
    }
    
    // 현재 캐릭터 확인
    const currentCharId = ctx.characterId;
    if (currentCharId === undefined) {
        toastr.error('캐릭터를 먼저 선택해주세요.');
        return;
    }
    
    // 최신 메시지부터 표시 (역순)
    const reversedChat = [...currentChat].reverse();
    
    const popupContent = `
        <div style="display:flex; flex-direction:column; gap:15px; min-width:500px; max-width:600px;">
            <h3 style="margin:0; text-align:center;">📦 메시지 백업</h3>
            
            <div style="max-height:300px; overflow-y:auto; border:1px solid var(--SmartThemeBorderColor); border-radius:5px; padding:10px; background:var(--SmartThemeBlurTintColor);">
                <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer; border-bottom:1px solid var(--SmartThemeBorderColor); margin-bottom:10px;">
                    <input type="checkbox" id="backup-select-all" style="width:18px; height:18px;">
                    <span style="font-weight:bold;">전체 선택</span>
                </label>
                ${reversedChat.map((msg, displayIndex) => {
                    const realIndex = currentChat.length - 1 - displayIndex;
                    return `
                        <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 5px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
                            <input type="checkbox" 
                                   class="backup-msg-checkbox" 
                                   data-index="${realIndex}"
                                   style="width:18px; height:18px; flex-shrink:0; margin-top:2px;">
                            <div style="flex:1; overflow:hidden;">
                                <div style="font-weight:bold; color:${msg.is_user ? '#6eb5ff' : '#ffa500'};">
                                    [${realIndex}] ${msg.name || (msg.is_user ? 'User' : 'Character')}
                                </div>
                                <div style="font-size:12px; opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:400px;">
                                    ${(msg.mes || '').substring(0, 100)}${(msg.mes || '').length > 100 ? '...' : ''}
                                </div>
                            </div>
                        </label>
                    `;
                }).join('')}
            </div>
            
            <small style="color:var(--SmartThemeBodyColor); opacity:0.7;">이동할 메시지를 선택하세요 (최신순)</small>
        </div>
    `;
    
    $(document).off('change', '#backup-select-all').on('change', '#backup-select-all', function() {
        $('.backup-msg-checkbox').prop('checked', this.checked);
    });
    
    const result = await getCallPopup()(popupContent, 'confirm', '', { okButton: '다음', cancelButton: '취소', wide: true });
    
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

/**
 * 파일명에서 .jsonl 확장자 제거
 */
function removeJsonlExtension(fileName) {
    if (fileName && fileName.endsWith('.jsonl')) {
        return fileName.slice(0, -6);
    }
    return fileName;
}

/**
 * 백업 대상 채팅 파일 선택 - API로 목록 가져오기
 */
async function openBackupTargetSelector(selectedIndices) {
    const ctx = getContext();
    const currentCharId = ctx.characterId;
    const currentCharacter = ctx.characters[currentCharId];
    
    if (!currentCharacter) {
        toastr.error('현재 캐릭터를 찾을 수 없습니다.');
        return;
    }
    
    // 현재 채팅 파일의 file_id (확장자 제거)
    const currentChatFileId = removeJsonlExtension(currentCharacter.chat);
    
    try {
        // 채팅 파일 목록 API로 가져오기
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
        
        if (!chatFiles || chatFiles.length <= 1) {
            toastr.info('이동할 수 있는 다른 채팅 파일이 없습니다.');
            return;
        }
        
        const popupContent = `
            <div style="display:flex; flex-direction:column; gap:15px; min-width:400px;">
                <h3 style="margin:0; text-align:center;">📁 대상 채팅 파일 선택</h3>
                <p style="margin:0; text-align:center; opacity:0.8;">${selectedIndices.length}개 메시지를 복사합니다</p>
                
                <div style="max-height:250px; overflow-y:auto; border:1px solid var(--SmartThemeBorderColor); border-radius:5px; padding:10px; background:var(--SmartThemeBlurTintColor);">
                    ${chatFiles.map((file) => {
                        // file_id 사용 (확장자 없음)
                        const fileId = file.file_id || removeJsonlExtension(file.file_name);
                        const displayName = file.file_name || fileId;
                        const isCurrent = fileId === currentChatFileId;
                        return `
                            <label style="display:flex; align-items:center; gap:8px; padding:8px 5px; cursor:${isCurrent ? 'not-allowed' : 'pointer'}; opacity:${isCurrent ? '0.5' : '1'}; border-bottom:1px solid rgba(255,255,255,0.1);">
                                <input type="radio" 
                                       name="backup-target" 
                                       class="backup-target-radio" 
                                       data-file-id="${fileId}"
                                       ${isCurrent ? 'disabled' : ''}
                                       style="width:18px; height:18px;">
                                <span>${displayName}${isCurrent ? ' (현재)' : ''}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
                
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="backup-delete-original" style="width:18px; height:18px;">
                    <span>원본 메시지 삭제 (이동)</span>
                </label>
            </div>
        `;
        
        const result = await getCallPopup()(popupContent, 'confirm', '', { okButton: '실행', cancelButton: '취소' });
        
        if (result) {
            const targetFileId = $('.backup-target-radio:checked').data('file-id');
            const deleteOriginal = $('#backup-delete-original').is(':checked');
            
            if (!targetFileId) {
                toastr.warning('대상 채팅 파일을 선택해주세요.');
                return;
            }
            
            await copyMessagesToFile(selectedIndices, targetFileId, currentChatFileId, deleteOriginal);
        }
        
    } catch (error) {
        console.error('[Broadcast] Error getting chat files:', error);
        toastr.error('채팅 파일 목록을 가져오는데 실패했습니다: ' + error.message);
    }
}

/**
 * 메시지를 다른 파일로 복사/이동 - openCharacterChat 사용
 */
async function copyMessagesToFile(indices, targetFileId, currentFileId, deleteOriginal) {
    const ctx = getContext();
    const currentChat = ctx.chat;
    
    try {
        toastr.info('메시지 처리 중...');
        
        // 복사할 메시지들 (인덱스 순서대로 정렬)
        const sortedIndices = [...indices].sort((a, b) => a - b);
        const messagesToCopy = sortedIndices.map(i => JSON.parse(JSON.stringify(currentChat[i])));
        
        console.log('[Broadcast] Switching to target file:', targetFileId);
        
        // 1. 대상 채팅 파일로 전환 (file_id 사용 - 확장자 없음)
        await ctx.openCharacterChat(targetFileId);
        await sleep(2000);
        
        // 채팅 로드 완료 대기
        await waitForChatLoad();
        
        console.log('[Broadcast] Target chat loaded, messages:', ctx.chat.length);
        
        // 2. 대상 채팅에 메시지 추가
        const targetChat = ctx.chat;
        for (const msg of messagesToCopy) {
            targetChat.push(msg);
        }
        
        console.log('[Broadcast] Messages added, saving...');
        
        // 3. 대상 채팅 저장
        await ctx.saveChat();
        await sleep(500);
        
        console.log('[Broadcast] Saved, switching back to:', currentFileId);
        
        // 4. 원본 파일로 돌아가기 (file_id 사용)
        await ctx.openCharacterChat(currentFileId);
        await sleep(2000);
        await waitForChatLoad();
        
        // 5. 원본에서 삭제 (옵션)
        if (deleteOriginal) {
            const currentChatNow = ctx.chat;
            // 역순으로 삭제 (인덱스 밀림 방지)
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
        
        // 에러 시 원본 파일로 복귀 시도
        try {
            await ctx.openCharacterChat(currentFileId);
        } catch (e) {
            console.error('[Broadcast] Failed to return to original chat:', e);
        }
    }
}

/**
 * 채팅 로드 완료 대기
 */
function waitForChatLoad() {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 20;
        
        const checkInterval = setInterval(() => {
            attempts++;
            // 로딩 표시가 사라지면 완료
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

/**
 * 브로드캐스트 실행
 */
async function broadcastMessage(message, autoHide) {
    if (isProcessing) {
        toastr.warning('이미 진행 중입니다.');
        return;
    }
    
    isProcessing = true;
    const totalCount = selectedChats.length;
    const expectedPersona = extension_settings[extensionName].expectedPersona;
    
    toastr.info(`${totalCount}명에게 메시지 전송을 시작합니다...`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < selectedChats.length; i++) {
        const chatInfo = selectedChats[i];
        
        try {
            // 1. 캐릭터 전환 (/go 커맨드 사용)
            toastr.info(`${chatInfo.name} 채팅으로 이동 중...`);
            await switchToChat(chatInfo);
            
            // 2. 전환 검증 (캐릭터명 + 페르소나)
            const verified = await verifyCurrentChat(chatInfo.name, expectedPersona);
            if (!verified) {
                toastr.error(`${chatInfo.name}: 채팅 전환 검증 실패, 스킵합니다`);
                failCount++;
                continue;
            }
            
            const msgCountBefore = getContext().chat.length;
            
            // 3. 메시지 전송
            $('#send_textarea').val(message);
            $('#send_but').trigger('click');
            
            // 4. Typing Indicator가 사라질 때까지 대기 (응답 완료)
            toastr.info(`${chatInfo.name} 응답 대기 중...`);
            await waitForTypingIndicatorGone();
            
            // 5. 추가 안정화 대기
            await sleep(1000);
            
            // 6. 자동 숨기기
            if (autoHide) {
                const msgCountAfter = getContext().chat.length;
                if (msgCountAfter > msgCountBefore) {
                    const hideStart = msgCountBefore;
                    const hideEnd = msgCountAfter - 1;
                    
                    await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                    await sleep(500);
                    
                    // 하이드 완료 확인
                    const chat = getContext().chat;
                    const allHidden = chat.slice(hideStart, hideEnd + 1).every(m => m.is_hidden);
                    if (!allHidden) {
                        console.warn('[Broadcast] Hide verification failed, retrying...');
                        await executeSlashCommands(`/hide ${hideStart}-${hideEnd}`);
                        await sleep(500);
                    }
                }
            }
            
            successCount++;
            toastr.success(`${successCount}/${totalCount} 완료: ${chatInfo.name}`);
            
            // 다음 캐릭터로 넘어가기 전 잠시 대기
            if (i < selectedChats.length - 1) {
                await sleep(1500);
            }
            
        } catch (error) {
            console.error(`[Broadcast] Failed: ${chatInfo.name}`, error);
            failCount++;
            toastr.error(`실패: ${chatInfo.name} - ${error.message}`);
        }
    }
    
    isProcessing = false;
    
    if (failCount > 0) {
        toastr.warning(`전송 완료! 성공: ${successCount}, 실패: ${failCount}`);
    } else {
        toastr.success(`🎉 전송 완료! ${successCount}명 모두 성공!`);
    }
}

/**
 * 채팅 전환
 */
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

/**
 * 캐릭터 전환 완료 대기
 */
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

/**
 * 현재 채팅이 올바른지 검증 (캐릭터명 + 페르소나)
 */
async function verifyCurrentChat(expectedCharName, expectedPersona) {
    const ctx = getContext();
    
    // 1. 캐릭터명 검증
    let currentCharName = '';
    
    if (ctx.groupId) {
        // 그룹인 경우
        const groups = ctx.groups || [];
        const currentGroup = groups.find(g => g.id === ctx.groupId);
        currentCharName = currentGroup?.name || '';
    } else if (ctx.characterId !== undefined && ctx.characters) {
        // 개인 캐릭터인 경우
        const currentChar = ctx.characters[ctx.characterId];
        currentCharName = currentChar?.name || '';
    }
    
    // 캐릭터명 비교 (공백 무시, 대소문자 무시)
    const normalizedExpected = expectedCharName.trim().toLowerCase();
    const normalizedCurrent = currentCharName.trim().toLowerCase();
    
    if (normalizedExpected !== normalizedCurrent) {
        console.error(`[Broadcast] Character mismatch! Expected: ${expectedCharName}, Got: ${currentCharName}`);
        return false;
    }
    
    console.log(`[Broadcast] Character verified: ${currentCharName}`);
    
    // 2. 페르소나 검증 (설정된 경우에만)
    if (expectedPersona && expectedPersona.trim()) {
        const currentPersona = ctx.name1 || '';
        const normalizedExpectedPersona = expectedPersona.trim().toLowerCase();
        const normalizedCurrentPersona = currentPersona.trim().toLowerCase();
        
        if (normalizedExpectedPersona !== normalizedCurrentPersona) {
            console.error(`[Broadcast] Persona mismatch! Expected: ${expectedPersona}, Got: ${currentPersona}`);
            toastr.error(`페르소나 불일치: ${expectedPersona} ≠ ${currentPersona}`);
            return false;
        }
        
        console.log(`[Broadcast] Persona verified: ${currentPersona}`);
    }
    
    return true;
}

/**
 * Typing Indicator가 사라질 때까지 대기
 */
function waitForTypingIndicatorGone(maxWait = 300000) { // 최대 5분
    return new Promise((resolve) => {
        let elapsed = 0;
        const checkInterval = 500;
        
        // 먼저 typing indicator가 나타날 때까지 잠시 대기
        setTimeout(() => {
            const interval = setInterval(() => {
                elapsed += checkInterval;
                
                const typingIndicator = document.getElementById('typing_indicator');
                const isGenerating = $('#send_but').hasClass('displayNone') || 
                                    $('#mes_stop').is(':visible') ||
                                    $('#chat').hasClass('loading');
                
                // typing indicator가 없고 생성 중이 아니면 완료
                if (!typingIndicator && !isGenerating) {
                    clearInterval(interval);
                    console.log('[Broadcast] Response completed (typing indicator gone)');
                    resolve(true);
                    return;
                }
                
                // 최대 대기 시간 초과
                if (elapsed >= maxWait) {
                    clearInterval(interval);
                    console.warn('[Broadcast] Max wait time exceeded');
                    resolve(false);
                }
            }, checkInterval);
        }, 1000); // 1초 후부터 체크 시작
    });
}

/**
 * 슬립 함수
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 메뉴 버튼 추가
 */
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

/**
 * 초기화
 */
jQuery(async () => {
    console.log('[Broadcast] Extension loading...');
    
    loadSettings();
    createSettingsUI();
    
    setTimeout(() => {
        addMenuButtons();
    }, 1000);
    
    console.log('[Broadcast] Extension loaded!');
});
