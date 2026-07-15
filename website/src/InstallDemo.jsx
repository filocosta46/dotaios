import React, {useEffect, useRef, useState} from 'react'
import {COPY} from './content.js'
import MacWindow from './MacWindow.jsx'

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduce(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  return reduce
}

function useInView(ref) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      {threshold: 0.2},
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return visible
}

function TypeLine({text, active, speed = 16, onDone}) {
  const [value, setValue] = useState('')
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!active) {
      setValue('')
      return undefined
    }

    setValue('')
    let index = 0
    const timer = window.setInterval(() => {
      index += 1
      setValue(text.slice(0, index))
      if (index >= text.length) {
        window.clearInterval(timer)
        doneRef.current?.()
      }
    }, speed)

    return () => window.clearInterval(timer)
  }, [active, speed, text])

  return (
    <span>
      {value}
      {active && value.length < text.length ? (
        <span className="claude-cursor" aria-hidden="true">
          |
        </span>
      ) : null}
    </span>
  )
}

function ClaudeAvatar() {
  return (
    <div className="claude-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
      </svg>
    </div>
  )
}

function AssistantMessage({children, showAvatar = true}) {
  return (
    <div className="claude-msg claude-msg--assistant">
      {showAvatar ? <ClaudeAvatar /> : <span className="claude-avatar-spacer" aria-hidden="true" />}
      <div className="claude-msg-body">{children}</div>
    </div>
  )
}

function UserMessage({children}) {
  return (
    <div className="claude-msg claude-msg--user">
      <div className="claude-msg-body">{children}</div>
    </div>
  )
}

function SetupStatus({steps, visibleCount}) {
  return (
    <div className="claude-status-block">
      <p className="claude-status-label">Setting up your folder</p>
      <ul className="claude-status-list">
        {steps.map((step, index) => {
          if (index >= visibleCount) return null
          return (
            <li key={step} className="claude-status-item">
              <span className="claude-status-check" aria-hidden="true">
                ✓
              </span>
              {step}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function InstallDemo({t}) {
  const rootRef = useRef(null)
  const reduceMotion = usePrefersReducedMotion()
  const inView = useInView(rootRef)
  const demo = t.demo || {}

  const setupSteps = demo.setupSteps || [
    'Reading INSTALL.md from github.com/filocosta46/dotaios',
    'Creating ~/aios',
    'Writing context/identity.md, work.md, priorities.md',
    'Installing default skills',
  ]

  const onboarding = demo.onboarding || [
    {
      q: "What's your name, and what do you do for work?",
      a: 'Filippo. I run product and engineering.',
    },
    {
      q: "What are you working on right now? One thing or a few, whatever's taking up your mental energy.",
      a: 'Shipping DotAIOS and keeping my AI tools on the same page.',
    },
    {
      q: 'What matters most this week? What would make it a good week if it got done?',
      a: 'Get the website and onboarding flow live.',
    },
  ]

  const [phase, setPhase] = useState(reduceMotion ? 'done' : 'idle')
  const [showUserMsg, setShowUserMsg] = useState(reduceMotion)
  const [showAssistantIntro, setShowAssistantIntro] = useState(reduceMotion)
  const [visibleSteps, setVisibleSteps] = useState(reduceMotion ? setupSteps.length : 0)
  const [visibleQuestions, setVisibleQuestions] = useState(reduceMotion ? onboarding.length : 0)
  const [typingAnswer, setTypingAnswer] = useState(-1)
  const [finishedAnswers, setFinishedAnswers] = useState(() =>
    reduceMotion ? onboarding.map(() => true) : onboarding.map(() => false),
  )

  const userPrompt = COPY.installPrompt

  useEffect(() => {
    if (!inView || reduceMotion) return undefined
    if (phase === 'idle') setPhase('user')
    return undefined
  }, [inView, phase, reduceMotion])

  useEffect(() => {
    if (phase !== 'user' || reduceMotion) return undefined
    const timer = window.setTimeout(() => {
      setShowUserMsg(true)
      setPhase('typing-user')
    }, 300)
    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion])

  useEffect(() => {
    if (phase !== 'assistant' || reduceMotion) return undefined
    const timer = window.setTimeout(() => setShowAssistantIntro(true), 200)
    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion])

  useEffect(() => {
    if (phase !== 'setup' || reduceMotion) return undefined

    if (visibleSteps >= setupSteps.length) {
      const timer = window.setTimeout(() => setPhase('questions'), 500)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(() => setVisibleSteps((count) => count + 1), 420)
    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion, setupSteps.length, visibleSteps])

  useEffect(() => {
    if (phase !== 'questions' || reduceMotion) return undefined

    if (visibleQuestions >= onboarding.length) {
      const timer = window.setTimeout(() => setPhase('done'), 600)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(() => {
      setVisibleQuestions((count) => count + 1)
      setTypingAnswer(visibleQuestions)
    }, 800)

    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion, onboarding.length, visibleQuestions])

  function handleUserDone() {
    window.setTimeout(() => setPhase('assistant'), 350)
  }

  function handleIntroDone() {
    window.setTimeout(() => setPhase('setup'), 300)
  }

  function handleAnswerDone(index) {
    setFinishedAnswers((prev) => {
      const next = [...prev]
      next[index] = true
      return next
    })
    setTypingAnswer(-1)
  }

  const showSetup = reduceMotion || phase === 'setup' || phase === 'questions' || phase === 'done'
  const showQuestions = reduceMotion || phase === 'questions' || phase === 'done'

  return (
    <div className="install-demo" ref={rootRef} aria-label={demo.label || 'Setup preview'}>
      <MacWindow title={demo.windowTitle || 'Claude'} variant="claude">
        <div className="claude-chat" role="log" aria-live="polite">
          {showUserMsg ? (
            <UserMessage>
              {reduceMotion ? (
                userPrompt
              ) : phase === 'typing-user' ? (
                <TypeLine text={userPrompt} active speed={14} onDone={handleUserDone} />
              ) : (
                userPrompt
              )}
            </UserMessage>
          ) : null}

          {phase !== 'idle' && phase !== 'user' && phase !== 'typing-user' ? (
            <>
              {showAssistantIntro ? (
                <AssistantMessage>
                  {reduceMotion ? (
                    demo.assistantIntro ||
                      "I'll read the install guide and set up your local DotAIOS folder on your Mac."
                  ) : phase === 'assistant' ? (
                    <TypeLine
                      text={
                        demo.assistantIntro ||
                        "I'll read the install guide and set up your local DotAIOS folder on your Mac."
                      }
                      active
                      speed={12}
                      onDone={handleIntroDone}
                    />
                  ) : (
                    demo.assistantIntro ||
                    "I'll read the install guide and set up your local DotAIOS folder on your Mac."
                  )}
                </AssistantMessage>
              ) : null}

              {showSetup ? (
                <AssistantMessage showAvatar={false}>
                  <SetupStatus steps={setupSteps} visibleCount={visibleSteps} />
                </AssistantMessage>
              ) : null}

              {showQuestions
                ? onboarding.map((item, index) => {
                    if (!reduceMotion && index >= visibleQuestions) return null
                    const answerVisible =
                      reduceMotion || finishedAnswers[index] || typingAnswer === index

                    return (
                      <React.Fragment key={item.q}>
                        <AssistantMessage showAvatar={index === 0 || reduceMotion}>
                          <p className="claude-question">{item.q}</p>
                        </AssistantMessage>
                        {answerVisible ? (
                          <UserMessage>
                            {reduceMotion ? (
                              item.a
                            ) : typingAnswer === index && !finishedAnswers[index] ? (
                              <TypeLine
                                text={item.a}
                                active
                                speed={18}
                                onDone={() => handleAnswerDone(index)}
                              />
                            ) : finishedAnswers[index] ? (
                              item.a
                            ) : null}
                          </UserMessage>
                        ) : null}
                      </React.Fragment>
                    )
                  })
                : null}
            </>
          ) : null}
        </div>

        <div className="claude-input-bar" aria-hidden="true">
          <div className="claude-input-placeholder">{demo.inputPlaceholder || 'Reply to Claude...'}</div>
          <button className="claude-send-btn" type="button" tabIndex={-1}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </MacWindow>
    </div>
  )
}
