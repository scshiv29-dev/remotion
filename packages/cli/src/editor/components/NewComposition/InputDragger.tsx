import type {
	InputHTMLAttributes,
	MouseEventHandler,
	PointerEventHandler,
} from 'react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {interpolate} from 'remotion';
import {noop} from '../../helpers/noop';
import {getClickLock, setClickLock} from '../../state/input-dragger-click-lock';
import {HigherZIndex} from '../../state/z-index';
import {inputBaseStyle, RemotionInput} from './RemInput';

type Props = InputHTMLAttributes<HTMLInputElement> & {
	onValueChange: (newVal: number) => void;
	onTextChange: (newVal: string) => void;
};

export const InputDragger: React.FC<Props> = ({
	onValueChange,
	min: _min,
	step: _step,
	value,
	onTextChange,
	...props
}) => {
	const [inputFallback, setInputFallback] = useState(false);
	const fallbackRef = useRef<HTMLInputElement>(null);

	const style = useMemo(() => {
		return {
			...inputBaseStyle,
			backgroundColor: 'transparent',
			borderColor: 'transparent',
		};
	}, []);

	const span: React.CSSProperties = useMemo(
		() => ({
			borderBottom: '1px dotted var(--blue)',
			paddingBottom: 1,
			color: 'var(--blue)',
			cursor: 'ew-resize',
			userSelect: 'none',
			fontSize: 13,
			fontVariantNumeric: 'tabular-nums',
		}),
		[]
	);

	const onClick: MouseEventHandler<HTMLButtonElement> = useCallback((e) => {
		if (!getClickLock()) {
			e.stopPropagation();
		}

		if (getClickLock()) {
			return;
		}

		setInputFallback(true);
	}, []);

	const onEscape = useCallback(() => {
		setInputFallback(false);
	}, []);

	const onBlur = useCallback(() => {
		if (!fallbackRef.current) {
			return;
		}

		const newValue = fallbackRef.current.value;
		if (newValue.trim() === '') {
			onEscape();
			return;
		}

		if (fallbackRef.current.checkValidity()) {
			onTextChange?.(newValue);
			setInputFallback(false);
		} else {
			fallbackRef.current.reportValidity();
		}
	}, [onEscape, onTextChange]);

	const onKeyPress: React.KeyboardEventHandler<HTMLInputElement> = useCallback(
		(e) => {
			if (e.key === 'Enter') {
				fallbackRef.current?.blur();
			}
		},
		[]
	);

	const onPointerDown: PointerEventHandler = useCallback(
		(e) => {
			const {pageX, pageY} = e;
			const moveListener = (ev: MouseEvent) => {
				const xDistance = ev.pageX - pageX;
				const distanceFromStart = Math.sqrt(
					xDistance ** 2 + (ev.pageY - pageY) ** 2
				);
				const step = Number(_step ?? 1);
				const min = Number(_min ?? 0);
				if (distanceFromStart > 4) {
					setClickLock(true);
				}

				const diff = interpolate(
					xDistance,
					[-5, -4, 0, 4, 5],
					[-step, 0, 0, 0, step]
				);
				const newValue = Math.max(min, Math.floor(Number(value) + diff));
				const roundToStep = Math.floor(newValue / step) * step;
				onValueChange(roundToStep);
			};

			window.addEventListener('mousemove', moveListener);
			window.addEventListener(
				'pointerup',
				() => {
					window.removeEventListener('mousemove', moveListener);
					setTimeout(() => {
						setClickLock(false);
					}, 2);
				},
				{
					once: true,
				}
			);
		},
		[_step, _min, value, onValueChange]
	);

	useEffect(() => {
		if (inputFallback) {
			fallbackRef.current?.select();
		}
	}, [inputFallback]);

	if (inputFallback) {
		return (
			<HigherZIndex onEscape={onEscape} onOutsideClick={noop}>
				<RemotionInput
					ref={fallbackRef}
					autoFocus
					onKeyPress={onKeyPress}
					onBlur={onBlur}
					min={_min}
					step={_step}
					defaultValue={value}
					{...props}
				/>
			</HigherZIndex>
		);
	}

	return (
		<button
			type="button"
			style={style}
			onClick={onClick}
			onPointerDown={onPointerDown}
		>
			<span style={span}>{value}</span>
		</button>
	);
};
