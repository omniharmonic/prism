#import "WakeAudioBridgeTestSupport.h"
@implementation OmniTestWakeAudioNode
// AVAudioNode is a class cluster, so use an Objective-C message-compatible stand-in.
- (AVAudioNode *)audioNode { return (AVAudioNode *)self; }
- (void)installTapOnBus:(AVAudioNodeBus)bus bufferSize:(AVAudioFrameCount)size format:(AVAudioFormat *)format block:(AVAudioNodeTapBlock)block {
    _installations++;
    _receivedNativeFormat = format == nil;
    if (_failInstallation) [NSException raise:NSInvalidArgumentException format:@"Synthetic device route mismatch"];
}
@end

@implementation OmniTestWakeAudioEngine
- (AVAudioEngine *)audioEngine { return (AVAudioEngine *)self; }
- (void)prepare {
    if (_failPreparation) [NSException raise:NSInvalidArgumentException format:@"Synthetic route invalidation during prepare"];
}
- (BOOL)startAndReturnError:(NSError **)error {
    _starts++;
    if (_failStart) {
        if (error) *error = [NSError errorWithDomain:@"SyntheticAudioStart" code:3 userInfo:nil];
        return NO;
    }
    return YES;
}
@end
