#import "WakeAudioBridge.h"
@implementation OmniWakeAudioBridge
+ (BOOL)installTapOnNode:(AVAudioNode *)node block:(AVAudioNodeTapBlock)block error:(NSError **)error {
    @try {
        // nil follows the native bus format; never reapply an earlier route's format.
        [node installTapOnBus:0 bufferSize:1024 format:nil block:block];
        return YES;
    } @catch (NSException *exception) {
        if (error) *error = [NSError errorWithDomain:@"OmniWakeAudioStartup" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"Microphone tap could not be installed",
                       @"exceptionName": exception.name}];
        return NO;
    }
}
+ (BOOL)prepareAndStartEngine:(AVAudioEngine *)engine error:(NSError **)error {
    @try {
        [engine prepare];
        return [engine startAndReturnError:error];
    } @catch (NSException *exception) {
        if (error) *error = [NSError errorWithDomain:@"OmniWakeAudioStartup" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"Microphone engine could not be started",
                       @"exceptionName": exception.name}];
        return NO;
    }
}
@end
