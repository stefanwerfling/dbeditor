/*
 * Every literal ${VAR} in this file is *test data* — the placeholder syntax
 * understood by EnvPlaceholderResolver.resolve — and not an accidentally-untemplated
 * template literal. Disable the lint check that flags these as suspicious.
 */
/* eslint-disable no-template-curly-in-string */
import {describe, expect, it} from 'vitest';
import {EnvPlaceholderError, EnvPlaceholderResolver} from '../../Config/EnvPlaceholderResolver.js';

describe('EnvPlaceholderResolver.resolve', () => {

    it('substitutes ${VAR} from the env map', () => {
        const out = EnvPlaceholderResolver.resolve({host: '${HOST}'}, {HOST: 'db.local'});
        expect(out).toEqual({host: 'db.local'});
    });

    it('falls back to default when VAR is undefined', () => {
        const out = EnvPlaceholderResolver.resolve({host: '${HOST:-localhost}'}, {});
        expect(out).toEqual({host: 'localhost'});
    });

    it('falls back to default when VAR is an empty string', () => {
        const out = EnvPlaceholderResolver.resolve({host: '${HOST:-localhost}'}, {HOST: ''});
        expect(out).toEqual({host: 'localhost'});
    });

    it('uses defined value over default when both present', () => {
        const out = EnvPlaceholderResolver.resolve({host: '${HOST:-localhost}'}, {HOST: 'db.local'});
        expect(out).toEqual({host: 'db.local'});
    });

    it('throws EnvPlaceholderError when required VAR is unset and no default given', () => {
        expect(() => EnvPlaceholderResolver.resolve({password: '${PWD}'}, {}))
        .toThrowError(EnvPlaceholderError);
    });

    it('error message names the missing variable and config path', () => {
        try {
            EnvPlaceholderResolver.resolve({db: {auth: {password: '${PWD}'}}}, {});
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(EnvPlaceholderError);
            const msg = (e as Error).message;
            expect(msg).toContain('${PWD}');
            expect(msg).toContain('db.auth.password');
        }
    });

    it('escapes $$ to a literal $', () => {
        const out = EnvPlaceholderResolver.resolve({s: '$${VAR}'}, {VAR: 'should-not-be-used'});
        expect(out).toEqual({s: '${VAR}'});
    });

    it('handles multiple placeholders in one string', () => {
        const out = EnvPlaceholderResolver.resolve(
            {url: '${PROTO}://${HOST}:${PORT}'},
            {PROTO: 'mysql', HOST: 'db', PORT: '3306'}
        );
        expect(out).toEqual({url: 'mysql://db:3306'});
    });

    it('walks arrays and nested objects', () => {
        const out = EnvPlaceholderResolver.resolve(
            {connections: [{host: '${H1}'}, {host: '${H2:-fallback}'}]},
            {H1: 'first'}
        );
        expect(out).toEqual({connections: [{host: 'first'}, {host: 'fallback'}]});
    });

    it('leaves non-string scalars untouched', () => {
        const out = EnvPlaceholderResolver.resolve(
            {port: 5174, ssl: true, retries: null},
            {}
        );
        expect(out).toEqual({port: 5174, ssl: true, retries: null});
    });

    it('does not mutate the input object', () => {
        const input = {host: '${HOST}'};
        EnvPlaceholderResolver.resolve(input, {HOST: 'db.local'});
        expect(input).toEqual({host: '${HOST}'});
    });

    it('leaves strings without placeholders unchanged', () => {
        const out = EnvPlaceholderResolver.resolve({name: 'plain-string'}, {});
        expect(out).toEqual({name: 'plain-string'});
    });

});