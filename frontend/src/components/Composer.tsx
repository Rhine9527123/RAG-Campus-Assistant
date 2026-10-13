import { useEffect, useRef, useState } from "react";

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
}

const SPEECH_ERRORS: Record<string, string> = {
  "not-allowed": "麦克风权限被拒绝，请在浏览器设置中允许后重试",
  "service-not-allowed": "浏览器未授权语音识别服务",
  "no-speech": "没有检测到语音，请靠近麦克风重试",
  network: "语音识别服务不可用（网络问题），请改用文字输入",
  "audio-capture": "未检测到麦克风设备，请检查设备后重试",
  "language-not-supported": "当前环境不支持中文语音识别，请改用文字输入",
  aborted: "",
};

export default function Composer({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  const speechSupported =
    typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  useEffect(() => {
    return () => {
      try {
        recogRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setSpeechError("当前浏览器不支持语音识别，请改用文字输入");
      return;
    }
    setSpeechError("");
    baseTextRef.current = value ? `${value} ` : "";

    const recog = new SR();
    recog.lang = "zh-CN";
    recog.continuous = false;
    recog.interimResults = true;
    recog.maxAlternatives = 1;

    let finalText = "";
    recog.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      setValue(baseTextRef.current + finalText + interim);
    };
    recog.onerror = (event) => {
      const msg = SPEECH_ERRORS[event.error];
      if (msg !== "") setSpeechError(msg ?? "语音识别失败，请改用文字输入");
      setListening(false);
    };
    recog.onend = () => {
      setListening(false);
      recogRef.current = null;
    };

    recogRef.current = recog;
    setListening(true);
    try {
      recog.start();
    } catch {
      setListening(false);
      setSpeechError("无法启动语音识别，请改用文字输入");
    }
  };

  const stopListening = () => {
    try {
      recogRef.current?.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  };

  const toggleSpeech = () => {
    if (listening) stopListening();
    else startListening();
  };

  return (
    <div className="composer-wrap">
      {speechError && <div className="speech-error">{speechError}</div>}
      {listening && (
        <div className="listening-bar" role="status">
          <span className="listening-bar__dot" />
          🎙 正在聆听…（点麦克风停止）
        </div>
      )}
      <div className="composer">
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={value}
          placeholder={listening ? "正在识别语音…" : "输入你的校园问题，例如：转专业需要什么条件"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        {speechSupported && (
          <button
            className={`composer__mic${listening ? " composer__mic--on" : ""}`}
            type="button"
            onClick={toggleSpeech}
            disabled={disabled}
            title={listening ? "停止录音" : "语音输入"}
            aria-label={listening ? "停止录音" : "语音输入"}
          >
            {listening ? "■" : "🎤"}
          </button>
        )}
        <button className="composer__send" type="button" onClick={submit} disabled={disabled || !value.trim()}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path fill="currentColor" d="M3.4 20.4 21.85 12 3.4 3.6l.01 6.53L16 12 3.41 13.87z" />
          </svg>
          <span>发送</span>
        </button>
      </div>
    </div>
  );
}
