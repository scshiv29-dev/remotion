/* eslint-disable no-new */
import {CDPSession, JSHandle, Protocol} from 'puppeteer-core';
import {SymbolicateableError} from './error-handling/symbolicateable-error';
import {parseStack} from './parse-browser-error-stack';

export const EVALUATION_SCRIPT_URL = '__puppeteer_evaluation_script__';
const SOURCE_URL_REGEX = /^[\040\t]*\/\/[@#] sourceURL=\s*(\S*?)\s*$/m;

function valueFromRemoteObject(remoteObject: Protocol.Runtime.RemoteObject) {
	if (remoteObject.unserializableValue) {
		if (remoteObject.type === 'bigint' && typeof BigInt !== 'undefined')
			return BigInt(remoteObject.unserializableValue.replace('n', ''));
		switch (remoteObject.unserializableValue) {
			case '-0':
				return -0;
			case 'NaN':
				return NaN;
			case 'Infinity':
				return Infinity;
			case '-Infinity':
				return -Infinity;
			default:
				throw new Error(
					'Unsupported unserializable value: ' +
						remoteObject.unserializableValue
				);
		}
	}

	return remoteObject.value;
}

function isString(obj: unknown): obj is string {
	return typeof obj === 'string' || obj instanceof String;
}

export async function _evaluateInternal<ReturnType>({
	client,
	contextId,
	pageFunction,
	frame,
	args = [],
}: {
	client: CDPSession;
	contextId: number;
	pageFunction: Function | string;
	frame: number | null;
	args?: unknown[];
}): Promise<ReturnType> {
	const suffix = `//# sourceURL=${EVALUATION_SCRIPT_URL}`;

	if (isString(pageFunction)) {
		const expression = pageFunction;
		const expressionWithSourceUrl = SOURCE_URL_REGEX.test(expression)
			? expression
			: expression + '\n' + suffix;

		const {exceptionDetails: exceptDetails, result: remotObject} = (await client
			.send('Runtime.evaluate', {
				expression: expressionWithSourceUrl,
				contextId,
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			})
			.catch(rewriteError)) as Protocol.Runtime.CallFunctionOnResponse;

		if (exceptDetails) {
			const err = new SymbolicateableError({
				stack: exceptDetails.exception?.description as string,
				name: exceptDetails.exception?.className as string,
				message: exceptDetails.exception?.description?.split('\n')[0] as string,
				frame,
				stackFrame: parseStack(
					(exceptDetails.exception?.description as string).split('\n')
				),
			});
			throw err;
		}

		return valueFromRemoteObject(remotObject);
	}

	if (typeof pageFunction !== 'function')
		throw new Error(
			`Expected to get |string| or |function| as the first argument, but got "${pageFunction}" instead.`
		);

	let functionText = pageFunction.toString();
	try {
		// eslint-disable-next-line no-new-func
		new Function('(' + functionText + ')');
	} catch (error) {
		// This means we might have a function shorthand. Try another
		// time prefixing 'function '.
		if (functionText.startsWith('async '))
			functionText =
				'async function ' + functionText.substring('async '.length);
		else functionText = 'function ' + functionText;
		try {
			// eslint-disable-next-line no-new-func
			new Function('(' + functionText + ')');
		} catch (err) {
			// We tried hard to serialize, but there's a weird beast here.
			throw new Error('Passed function is not well-serializable!');
		}
	}

	let callFunctionOnPromise;
	try {
		callFunctionOnPromise = client.send('Runtime.callFunctionOn', {
			functionDeclaration: functionText + '\n' + suffix + '\n',
			executionContextId: contextId,
			arguments: args.map(
				(a) => convertArgument(a) as Protocol.Runtime.CallArgument
			),
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
	} catch (error) {
		if (
			error instanceof TypeError &&
			error.message.startsWith('Converting circular structure to JSON')
		)
			error.message += ' Are you passing a nested JSHandle?';
		throw error;
	}

	const {exceptionDetails, result: remoteObject} =
		(await callFunctionOnPromise.catch(
			rewriteError
		)) as Protocol.Runtime.CallFunctionOnResponse;
	if (exceptionDetails) {
		const err = new SymbolicateableError({
			stack: exceptionDetails.exception?.description as string,
			name: exceptionDetails.exception?.className as string,
			message: exceptionDetails.exception?.description?.split(
				'\n'
			)[0] as string,
			frame,
			stackFrame: parseStack(
				(exceptionDetails.exception?.description as string).split('\n')
			),
		});
		throw err;
	}

	return valueFromRemoteObject(remoteObject);
}

/**
 * @param {*} arg
 * @returns {*}
 * @this {ExecutionContext}
 */
function convertArgument(arg: unknown): unknown {
	if (typeof arg === 'bigint')
		// eslint-disable-line valid-typeof
		return {unserializableValue: `${arg.toString()}n`};
	if (Object.is(arg, -0)) return {unserializableValue: '-0'};
	if (Object.is(arg, Infinity)) return {unserializableValue: 'Infinity'};
	if (Object.is(arg, -Infinity)) return {unserializableValue: '-Infinity'};
	if (Object.is(arg, NaN)) return {unserializableValue: 'NaN'};
	const objectHandle = arg && arg instanceof JSHandle ? arg : null;
	if (objectHandle) {
		if (objectHandle._disposed) throw new Error('JSHandle is disposed!');
		if (objectHandle._remoteObject.unserializableValue)
			return {
				unserializableValue: objectHandle._remoteObject.unserializableValue,
			};
		if (!objectHandle._remoteObject.objectId)
			return {value: objectHandle._remoteObject.value};
		return {objectId: objectHandle._remoteObject.objectId};
	}

	return {value: arg};
}

function rewriteError(error: Error): Protocol.Runtime.EvaluateResponse {
	if (error.message.includes('Object reference chain is too long'))
		return {result: {type: 'undefined'}};
	if (error.message.includes("Object couldn't be returned by value"))
		return {result: {type: 'undefined'}};

	if (
		error.message.endsWith('Cannot find context with specified id') ||
		error.message.endsWith('Inspected target navigated or closed')
	)
		throw new Error(
			'Execution context was destroyed, most likely because of a navigation.'
		);
	throw error;
}
