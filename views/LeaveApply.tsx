
import React, { useState, useContext, useEffect, useRef } from 'react';
import { AuthContext } from '../App';
import { LeaveType, RequestStatus, Gender, LeaveRequest, ApprovalLog, LeaveCategory, GenderRestriction, OvertimeSettlementRecord } from '../types';
import { db } from '../services/mockDb';
import { useNavigate, useLocation } from 'react-router-dom';
import { UserPlus, AlertCircle, Paperclip, ExternalLink, Upload, Trash2, Loader2, FileText, X, Check, Calculator } from 'lucide-react';

export default function LeaveApply() {
  const { user, refreshUser } = useContext(AuthContext);
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editRequestId, setEditRequestId] = useState<string | null>(null);

  // Deletion Modal State
  const [isDelModalOpen, setIsDelModalOpen] = useState(false);
  const [urlToDel, setUrlToDel] = useState<string | null>(null);

  const [availableLeaveTypes, setAvailableLeaveTypes] = useState<LeaveCategory[]>([]);
  const [allRequests, setAllRequests] = useState<LeaveRequest[]>([]);
  const [overtimeRecords, setOvertimeRecords] = useState<OvertimeSettlementRecord[]>([]);

  const [formData, setFormData] = useState({
    type: LeaveType.ANNUAL as string,
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    isPartialDay: false,
    startTime: '09:00',
    endTime: '18:00',
    reason: '',
    deputy: '',
    attachmentUrls: [] as string[]
  });

  useEffect(() => {
    const loadData = async () => {
        if (user) {
            const [allTypes, reqs, recs] = await Promise.all([
                db.getLeaveCategories(), 
                db.getRequests(),
                db.getOvertimeRecords()
            ]);
            setAllRequests(reqs);
            setOvertimeRecords(recs);
            const filtered = allTypes.filter(t => {
                if (t.allowedGender === GenderRestriction.ALL) return true;
                if (user.gender === Gender.MALE && t.allowedGender === GenderRestriction.MALE_ONLY) return true;
                if (user.gender === Gender.FEMALE && t.allowedGender === GenderRestriction.FEMALE_ONLY) return true;
                return false;
            });
            setAvailableLeaveTypes(filtered);
            if (!filtered.some(t => t.name === formData.type)) {
                setFormData(prev => ({ ...prev, type: filtered[0]?.name || '' }));
            }
        }
    };
    loadData();
  }, [user]);

  useEffect(() => {
    if (location.state && location.state.editRequest) {
        const req = location.state.editRequest as LeaveRequest;
        setFormData({
            type: req.type,
            startDate: req.startDate,
            endDate: req.endDate,
            isPartialDay: req.isPartialDay,
            startTime: req.startTime || '09:00',
            endTime: req.endTime || '18:00',
            reason: req.reason,
            deputy: req.deputy || '',
            attachmentUrls: req.attachmentUrls || (req.attachmentUrl ? [req.attachmentUrl] : [])
        });
        setIsEditMode(true);
        setEditRequestId(req.id);
    }
  }, [location.state]);

  if (!user) return null;

  // --- Quota Calculation Functions ---
  const calculateDays = (startStr: string, endStr: string, isPartial: boolean, timeStart?: string, timeEnd?: string) => {
    if (!isPartial) {
      const start = new Date(startStr), end = new Date(endStr);
      return Math.ceil(Math.abs(end.getTime() - start.getTime()) / 86400000) + 1;
    } else {
       if (timeStart && timeEnd) {
        const [sh, sm] = timeStart.split(':').map(Number), [eh, em] = timeEnd.split(':').map(Number);
        return parseFloat((((eh * 60 + em) - (sh * 60 + sm)) / 480).toFixed(3));
       }
       return 0;
    }
  };

  const formatQuota = (val: number, isHours = false) => {
    const absVal = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    // If input is hours (for Compensatory), convert to days/hours format
    if (isHours) {
        const d = Math.floor(absVal / 8);
        const h = parseFloat((absVal % 8).toFixed(1));
        // 特殊處理：如果是 8.5 小時，顯示 1天0.5小時 (8.5小時) 讓顯示更清楚
        const detailedStr = h === 0 ? `${sign}${d}天` : `${sign}${d}天${h}小時`;
        return `${detailedStr} (${val.toFixed(1)}小時)`;
    }
    // Default day input
    const d = Math.floor(absVal);
    const h = Math.round((absVal - d) * 8);
    return h === 0 ? `${sign}${d}天` : `${sign}${d}天${h}小時`;
  };

  const getDynamicQuotaInfo = (targetType: string, targetYear: number) => {
      // 1. 抵休 (Compensatory) 邏輯: 依據管理員結算
      if (targetType === LeaveType.COMPENSATORY) {
          const userRecs = overtimeRecords.filter(r => r.userId === user.id);
          
          // 與 Dashboard 邏輯同步：優先抓取「當前年份與月份」的結算紀錄
          const now = new Date();
          const cY = now.getFullYear();
          const cM = now.getMonth() + 1;
          const currentMonthRecord = userRecs.find(r => r.year === cY && r.month === cM);
          
          // 若無當月紀錄，則使用最新的歷史紀錄
          const latestSettled = currentMonthRecord || userRecs.sort((a, b) => (b.year - a.year) || (b.month - a.month))[0];
          
          // Settled Balance (已結算餘額)
          const settledHours = latestSettled ? latestSettled.remainingHours : (user.quota.overtime * 8);

          // Pending Usage (簽核中抵休)
          // 定義：申請請假頁面中，類型為「抵休」且尚未核准/駁回的單據
          const pendingUsageRequests = allRequests.filter(req => 
              req.userId === user.id && 
              req.type === LeaveType.COMPENSATORY &&
              (req.status === RequestStatus.IN_PROCESS || req.status.startsWith('待')) &&
              (!isEditMode || req.id !== editRequestId) // 排除編輯中的自己，避免重複扣除
          );
          
          const pendingUsageHours = pendingUsageRequests.reduce((acc, req) => {
              // calculateDays 回傳的是天數 (8小時制)，需轉換為小時
              const days = calculateDays(req.startDate, req.endDate, req.isPartialDay, req.startTime, req.endTime);
              return acc + (days * 8);
          }, 0);

          // Remaining (含預扣) = 結算餘額 - 簽核中抵休
          const remainingHours = settledHours - pendingUsageHours;
          
          // UI Mapping (Units: Hours -> Days/Hours)
          return { 
              totalQuota: formatQuota(settledHours, true), // 顯示為 "已結算餘額"
              used: formatQuota(0, true), 
              pending: formatQuota(pendingUsageHours, true), // "簽核中 (抵休)"
              remaining: formatQuota(remainingHours, true), // "剩餘可用"
              
              // 用於防呆的數值 (單位：天數)
              realAvailableDays: remainingHours / 8
          };
      }

      // 2. 特休 (Annual) 邏輯: 依據年度額度
      let totalQuota = (user.quota.annual[targetYear] || 0);
      let used = 0, pending = 0;
      allRequests.forEach(req => {
          if (req.userId !== user.id || req.type !== targetType || (isEditMode && editRequestId === req.id)) return;
          if (targetType === LeaveType.ANNUAL && new Date(req.startDate).getFullYear() !== targetYear) return;
          const duration = calculateDays(req.startDate, req.endDate, req.isPartialDay, req.startTime, req.endTime);
          if (req.status === RequestStatus.APPROVED) used += duration;
          else if (req.status === RequestStatus.IN_PROCESS || req.status.startsWith('待')) pending += duration;
      });
      return { 
          totalQuota: formatQuota(totalQuota), 
          used: formatQuota(used), 
          pending: formatQuota(pending), 
          remaining: formatQuota(Math.max(0, totalQuota - (used + pending))), 
          realAvailableDays: Math.max(0, totalQuota - (used + pending)) 
      };
  };

  const selectedYear = new Date(formData.startDate).getFullYear();
  const quotaInfo = getDynamicQuotaInfo(formData.type, selectedYear);

  // --- Attachment Logic (NEW) ---
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setUploading(true);
      setError('');
      try {
          const newUrls: string[] = [];
          for (let i = 0; i < files.length; i++) {
              const file = files[i];
              if (file.size > 3 * 1024 * 1024) throw new Error(`檔案「${file.name}」超過 3MB 限制。`);
              const seq = formData.attachmentUrls.length + i + 1;
              const url = await db.uploadFile(file, user.id, user.employeeId, formData.startDate, seq);
              newUrls.push(url);
          }
          setFormData(p => ({ ...p, attachmentUrls: [...p.attachmentUrls, ...newUrls] }));
      } catch (err: any) {
          setError(err.message || '上傳失敗');
      } finally {
          setUploading(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
      }
  };

  const confirmDelete = async () => {
      if (!urlToDel) return;
      setUploading(true);
      setIsDelModalOpen(false);
      try {
          await db.deleteFile(urlToDel);
          setFormData(p => ({ ...p, attachmentUrls: p.attachmentUrls.filter(u => u !== urlToDel) }));
      } catch (e) { setError('刪除失敗'); } finally { setUploading(false); setUrlToDel(null); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
        const conflict = await db.checkTimeOverlap(user.id, formData.startDate, formData.endDate, formData.startTime, formData.endTime, formData.isPartialDay, editRequestId || undefined);
        if (conflict.overlap) throw new Error(`時間重疊！您已有一筆「${conflict.conflictingRequest?.type}」申請。`);

        const requestDays = calculateDays(formData.startDate, formData.endDate, formData.isPartialDay, formData.startTime, formData.endTime);
        
        // 額度檢核
        if (formData.type === LeaveType.ANNUAL || formData.type === LeaveType.COMPENSATORY) {
            // 使用 realAvailableDays 來進行防呆
            // 若 realAvailableDays < 0 代表餘額已透支，這裡檢查本次申請是否超過剩餘量
            if (requestDays > quotaInfo.realAvailableDays) {
                const availText = formatQuota(Math.max(0, quotaInfo.realAvailableDays * 8), true);
                const reqText = formatQuota(requestDays * 8, true);
                throw new Error(`額度不足。剩餘可用 ${availText}，本次申請需 ${reqText}。`);
            }
        }

        const userGroup = await db.getUserWorkflowGroup(user.id);
        if (!userGroup) throw new Error('找不到簽核流程設定。');
        let totalSteps = userGroup.steps.length;
        const rule = userGroup.titleRules.find(r => r.jobTitle === user.jobTitle);
        if (rule) totalSteps = Math.min(rule.maxLevel, totalSteps);

        const record: LeaveRequest = {
          id: isEditMode && editRequestId ? editRequestId : crypto.randomUUID(),
          userId: user.id, userName: user.name,
          ...formData,
          attachmentUrl: formData.attachmentUrls[0] || '', // 相容舊版顯示
          status: RequestStatus.IN_PROCESS,
          createdAt: new Date().toISOString(),
          currentStep: 1, stepApprovedBy: [], totalSteps, logs: []
        };

        if (isEditMode && editRequestId) await db.updateRequest(record);
        else await db.createRequest(record);

        await refreshUser();
        navigate('/my-requests');
    } catch (err: any) { setError(err.message); setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto pb-12 animate-in fade-in duration-500">
      <div className="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 px-8 py-6 border-b flex justify-between items-center">
            <h2 className="text-2xl font-black text-slate-800 flex items-center gap-3">
                <div className="w-2 h-8 bg-blue-600 rounded-full"></div>
                {isEditMode ? '修改請假申請' : '申請請假'}
            </h2>
            {uploading && <div className="text-blue-600 font-bold animate-pulse text-sm flex items-center gap-2"><Loader2 size={16} className="animate-spin"/> 正在處理附件...</div>}
        </div>
        
        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          {error && (
              <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm flex items-center gap-2">
                  <AlertCircle size={18} /> <span className="font-bold">{error}</span>
              </div>
          )}

          {/* 1. 請假類型 (RETAINED) */}
          <div className="space-y-2">
            <label className="block text-xs font-black text-slate-400 uppercase tracking-widest ml-1">請假類型</label>
            <select
                value={formData.type}
                onChange={(e) => setFormData({...formData, type: e.target.value})}
                className="w-full px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-2xl outline-none font-black text-slate-700 focus:border-blue-500 transition-all appearance-none cursor-pointer"
            >
                {availableLeaveTypes.map((cat) => <option key={cat.id} value={cat.name}>{cat.name}</option>)}
            </select>
          </div>

          {/* 2. 額度資訊區塊 (MODIFIED) */}
          {(formData.type === LeaveType.ANNUAL || formData.type === LeaveType.COMPENSATORY) && (
              <div className={`p-4 rounded-2xl border-2 animate-in slide-in-from-top-2 ${formData.type === LeaveType.COMPENSATORY ? 'bg-orange-50/50 border-orange-100' : 'bg-blue-50/50 border-blue-100'}`}>
                  <div className="flex justify-between items-center mb-2">
                      <span className={`font-black text-sm ${formData.type === LeaveType.COMPENSATORY ? 'text-orange-700' : 'text-blue-700'}`}>
                          {formData.type === LeaveType.COMPENSATORY ? '抵休剩餘 (含預扣):' : `${selectedYear}年度 ${formData.type}剩餘 (含預扣):`}
                      </span>
                      <span className={`font-black text-xl ${formData.type === LeaveType.COMPENSATORY ? 'text-orange-700' : 'text-blue-700'}`}>
                          {quotaInfo.remaining}
                      </span>
                  </div>
                  {/* Layout for Equation */}
                  <div className={`flex flex-wrap items-center gap-2 text-[10px] font-bold ${formData.type === LeaveType.COMPENSATORY ? 'text-orange-600' : 'text-blue-500'}`}>
                      {formData.type === LeaveType.COMPENSATORY ? (
                          <>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm" title="來自儀表板加班補休餘額">已結算餘額: {quotaInfo.totalQuota}</span>
                            <span>-</span>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm" title="目前流程中尚未核准的單據">簽核中 (抵休): {quotaInfo.pending}</span>
                            <span>=</span>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm">剩餘可用: {quotaInfo.remaining}</span>
                          </>
                      ) : (
                          <>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm">總額: {quotaInfo.totalQuota}</span>
                            <span>=</span>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm">已核准: {quotaInfo.used}</span>
                            <span>+</span>
                            <span className="px-2 py-1 bg-white/50 rounded border border-current shadow-sm">簽核中: {quotaInfo.pending}</span>
                          </>
                      )}
                  </div>
              </div>
          )}

          {/* 3. 部分工時與日期 (RETAINED) */}
          <div className="bg-slate-50 p-6 rounded-3xl border-2 border-slate-100 space-y-4">
              <div className="flex items-center gap-3">
                  <input type="checkbox" id="partial" checked={formData.isPartialDay} onChange={(e) => setFormData({...formData, isPartialDay: e.target.checked})} className="w-5 h-5 text-blue-600 rounded-lg cursor-pointer" />
                  <label htmlFor="partial" className="text-sm font-black text-slate-700 cursor-pointer">此為部分工時 / 小時請假</label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">開始日期</label>
                      <input type="date" required value={formData.startDate} onChange={(e) => setFormData({...formData, startDate: e.target.value})} className="w-full px-4 py-2 bg-white border-2 border-slate-100 rounded-xl font-bold text-slate-700 focus:border-blue-500 outline-none" />
                  </div>
                  <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">結束日期</label>
                      <input type="date" required value={formData.endDate} min={formData.startDate} onChange={(e) => setFormData({...formData, endDate: e.target.value})} className="w-full px-4 py-2 bg-white border-2 border-slate-100 rounded-xl font-bold text-slate-700 focus:border-blue-500 outline-none" />
                  </div>
              </div>

              {formData.isPartialDay && (
                  <div className="grid grid-cols-2 gap-4 pt-2 animate-in fade-in">
                      <div className="space-y-1">
                          <label className="text-[10px] font-black text-blue-500 uppercase">開始時間</label>
                          <input type="time" value={formData.startTime} onChange={(e) => setFormData({...formData, startTime: e.target.value})} className="w-full px-4 py-2 border-2 border-blue-50 rounded-xl font-black text-blue-600 outline-none" />
                      </div>
                      <div className="space-y-1">
                          <label className="text-[10px] font-black text-blue-500 uppercase">結束時間</label>
                          <input type="time" value={formData.endTime} onChange={(e) => setFormData({...formData, endTime: e.target.value})} className="w-full px-4 py-2 border-2 border-blue-50 rounded-xl font-black text-blue-600 outline-none" />
                      </div>
                  </div>
              )}
          </div>

          {/* 4. 附件上傳 (NEW) */}
          <div className="space-y-4">
              <div className="flex justify-between items-center">
                  <label className="block text-xs font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                      <Paperclip size={16} className="text-blue-600" /> 證明附件管理 (單一檔案最大3MB)
                  </label>
              </div>
              <div onClick={() => !uploading && fileInputRef.current?.click()} className={`border-3 border-dashed rounded-[2rem] p-8 text-center transition-all cursor-pointer ${(uploading) ? 'bg-slate-100 opacity-60' : 'bg-blue-50/20 border-blue-100 hover:border-blue-400'}`}>
                  <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" multiple accept="image/*,.pdf,.doc,.docx" />
                  {uploading ? <Loader2 size={32} className="mx-auto text-blue-500 animate-spin" /> : <div className="flex flex-col items-center gap-2"><Upload className="text-blue-500"/><p className="text-sm font-black text-slate-600">點擊或拖放檔案上傳</p></div>}
              </div>
              {formData.attachmentUrls.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {formData.attachmentUrls.map((url, i) => (
                          <div key={i} className="bg-white border-2 border-slate-100 p-3 rounded-2xl flex items-center justify-between shadow-sm animate-in zoom-in-95">
                              <div className="flex items-center gap-2 overflow-hidden">
                                  <FileText size={16} className="text-blue-500 shrink-0" />
                                  <div className="overflow-hidden">
                                      <p className="text-[10px] font-black text-slate-700 truncate max-w-[120px]">{decodeURIComponent(url.split('/').pop() || '')}</p>
                                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-600 hover:underline flex items-center gap-1 font-bold"><ExternalLink size={10}/> 點擊檢視</a>
                                  </div>
                              </div>
                              <button type="button" onClick={() => { setUrlToDel(url); setIsDelModalOpen(true); }} className="p-2 text-slate-300 hover:text-red-600 transition-colors"><Trash2 size={16}/></button>
                          </div>
                      ))}
                  </div>
              )}
          </div>

          {/* 5. 職務代理人 (RETAINED) */}
          <div className="space-y-2 pt-2 border-t border-slate-100">
              <label className="block text-xs font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <UserPlus size={16} /> 職務代理人
              </label>
              <input 
                  type="text" required value={formData.deputy} 
                  onChange={(e) => setFormData({...formData, deputy: e.target.value})} 
                  className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl outline-none font-bold text-slate-700 focus:border-blue-500 transition-all" 
                  placeholder="請輸入代理人員姓名..."
              />
          </div>

          {/* 6. 事由 (RETAINED) */}
          <div className="space-y-2">
              <label className="block text-xs font-black text-slate-400 uppercase tracking-widest ml-1">請假具體事由</label>
              <textarea rows={3} required value={formData.reason} onChange={(e) => setFormData({...formData, reason: e.target.value})} className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl outline-none font-medium text-slate-700 focus:border-blue-500 transition-all resize-none" placeholder="請詳細敘述..." />
          </div>

          <div className="pt-6 flex justify-end gap-4 border-t">
             <button type="button" onClick={() => navigate('/my-requests')} className="px-8 py-3 bg-slate-100 text-slate-500 rounded-2xl font-black hover:bg-slate-200 transition-all">取消</button>
             <button type="submit" disabled={loading || uploading} className="px-12 py-3 bg-blue-600 text-white rounded-2xl font-black shadow-xl hover:bg-blue-700 active:scale-95 transition-all flex items-center gap-2">
                {loading ? <Loader2 className="animate-spin" size={20}/> : <Check size={20}/>} {loading ? '傳送中...' : '提交申請'}
             </button>
          </div>
        </form>
      </div>

      {/* Deletion Confirmation Modal */}
      {isDelModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
              <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-10 text-center animate-in zoom-in duration-300">
                  <div className="w-20 h-20 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner animate-pulse"><Trash2 size={36}/></div>
                  <h3 className="text-2xl font-black text-slate-800 mb-2">確定要刪除此附件？</h3>
                  <p className="text-sm text-slate-500 mb-8 font-medium">刪除後檔案將永久移除，無法復原。</p>
                  <div className="grid grid-cols-2 gap-4">
                      <button onClick={() => setIsDelModalOpen(false)} className="py-3 bg-slate-100 text-slate-600 rounded-2xl font-black hover:bg-slate-200 transition-all">取消</button>
                      <button onClick={confirmDelete} className="py-3 bg-red-600 text-white rounded-2xl font-black hover:bg-red-700 transition-all shadow-lg shadow-red-100">確定刪除</button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}
