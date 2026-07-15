import React, {useEffect, useMemo, useRef, useState} from 'react'
import {COPY} from './content.js'

const INIT_LINES = [
  'DotAIOS creates local memory files for the AI tools you already use.',
  '',
  'Creating ~/aios ...',
  'Writing context/identity.md, context/work.md, context/priorities.md',
  'Installing default skills ...',
  'Done. Your folder is ready.',
]

const ONBOARDING = [
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
      {threshold: 0.25},
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return visible
}

function TypeLine({text, active, speed = 22, onDone}) {
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
        <span className="demo-cursor" aria-hidden="true">
          |
        </span>
      ) : null}
    </span>
  )
}

export default function InstallDemo({t}) {
  const rootRef = useRef(null)
  const reduceMotion = usePrefersReducedMotion()
  const inView = useInView(rootRef)
  const [phase, setPhase] = useState(reduceMotion ? 'done' : 'idle')
  const [visibleLines, setVisibleLines] = useState(reduceMotion ? INIT_LINES.length : 0)
  const [visibleQuestions, setVisibleQuestions] = useState(reduceMotion ? ONBOARDING.length : 0)
  const [typingQuestion, setTypingQuestion] = useState(-1)
  const [finishedAnswers, setFinishedAnswers] = useState(() =>
    reduceMotion ? ONBOARDING.map(() => true) : ONBOARDING.map(() => false),
  )

  const prompt = COPY.installPrompt
  const initCommand = t.demo?.initCommand || 'npx dotaios init'

  useEffect(() => {
    if (!inView || reduceMotion) return undefined
    if (phase === 'idle') setPhase('prompt')
    return undefined
  }, [inView, phase, reduceMotion])

  useEffect(() => {
    if (phase !== 'init' || reduceMotion) return undefined

    if (visibleLines >= INIT_LINES.length) {
      const timer = window.setTimeout(() => setPhase('questions'), 500)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(() => setVisibleLines((count) => count + 1), 280)
    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion, visibleLines])

  useEffect(() => {
    if (phase !== 'questions' || reduceMotion) return undefined

    if (visibleQuestions >= ONBOARDING.length) {
      const timer = window.setTimeout(() => setPhase('done'), 600)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(() => {
      setVisibleQuestions((count) => count + 1)
      setTypingQuestion(visibleQuestions)
    }, 700)

    return () => window.clearTimeout(timer)
  }, [phase, reduceMotion, visibleQuestions])

  const initOutput = useMemo(
    () => (reduceMotion || phase === 'done' ? INIT_LINES : INIT_LINES.slice(0, visibleLines)),
    [phase, reduceMotion, visibleLines],
  )

  function handlePromptDone() {
    window.setTimeout(() => setPhase('init'), 400)
  }

  function handleAnswerDone(index) {
    setFinishedAnswers((prev) => {
      const next = [...prev]
      next[index] = true
      return next
    })
    setTypingQuestion(-1)
  }

  const showPrompt = reduceMotion || phase !== 'idle'
  const showInit = reduceMotion || phase === 'init' || phase === 'questions' || phase === 'done'
  const showQuestions = reduceMotion || phase === 'questions' || phase === 'done'

  return (
    <div className="install-demo" ref={rootRef} aria-label={t.demo?.label || 'Setup preview'}>
      <div className="demo-window">
        <div className="demo-topbar">
          <div className="window-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="demo-title">{t.demo?.windowTitle || 'DotAIOS setup'}</span>
        </div>
        <div className="demo-body">
          {showPrompt ? (
            <div className="demo-block demo-prompt-block">
              <p className="demo-label">{t.demo?.promptLabel || 'You'}</p>
              <p className="demo-prompt">
                {reduceMotion ? (
                  prompt
                ) : (
                  <TypeLine
                    text={prompt}
                    active={phase === 'prompt'}
                    speed={18}
                    onDone={handlePromptDone}
                  />
                )}
              </p>
            </div>
          ) : null}

          {showInit ? (
            <div className="demo-block demo-terminal-block">
              <p className="demo-label">{t.demo?.terminalLabel || 'Terminal'}</p>
              <div className="demo-terminal" role="log" aria-live="polite">
                <p className="demo-command">
                  <span className="demo-prompt-char">$</span> {initCommand}
                </p>
                {initOutput.map((line, index) => (
                  <p className="demo-line" key={`${line}-${index}`}>
                    {line || '\u00a0'}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          {showQuestions ? (
            <div className="demo-block demo-questions-block">
              <p className="demo-label">{t.demo?.questionsLabel || 'Onboarding'}</p>
              <ol className="demo-questions">
                {ONBOARDING.map((item, index) => {
                  if (!reduceMotion && index >= visibleQuestions) return null
                  const showAnswer = reduceMotion || finishedAnswers[index] || typingQuestion === index

                  return (
                    <li key={item.q} className="demo-question">
                      <p className="demo-question-text">{item.q}</p>
                      {showAnswer ? (
                        <p className="demo-answer">
                          {reduceMotion ? (
                            item.a
                          ) : typingQuestion === index && !finishedAnswers[index] ? (
                            <TypeLine
                              text={item.a}
                              active
                              speed={20}
                              onDone={() => handleAnswerDone(index)}
                            />
                          ) : finishedAnswers[index] ? (
                            item.a
                          ) : null}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
