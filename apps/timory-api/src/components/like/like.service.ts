import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ObjectId } from 'mongoose';
import { Like, MeLiked } from '../../libs/dto/like/like';
import { LikeInput } from '../../libs/dto/like/like.input';
import { T } from '../../libs/types/common';
import { Message } from '../../libs/enums/common.enum';
import { LikeGroup } from '../../libs/enums/like.enum';
import { OrdinaryInquiry } from '../../libs/dto/watch/watch.input';
import { Watches } from '../../libs/dto/watch/watch';
import { lookupFavorite } from '../../libs/config';

@Injectable()
export class LikeService {
	constructor(@InjectModel('Like') private readonly likeModel: Model<Like>) {}

	public async toggleLike(input: LikeInput): Promise<number> {
		const { memberId, likeRefId, likeGroup } = input;

		const search: T = { memberId: input.memberId, likeRefId: input.likeRefId, likeGroup: input.likeGroup };
		const exist = await this.likeModel.findOne(search).exec();
		let modifier = 1;

		if (exist) {
			console.log('LikeService.toggleLike - UNLIKE:', {
				memberId: String(memberId),
				likeRefId: String(likeRefId),
				likeGroup,
			});
			await this.likeModel.findOneAndDelete(search).exec();
			modifier = -1;
		} else {
			try {
				console.log('LikeService.toggleLike - LIKE:', {
					memberId: String(memberId),
					likeRefId: String(likeRefId),
					likeGroup,
				});
				await this.likeModel.create(input);
			} catch (err) {
				console.log('Error, Service.model:', err.message);
				throw new BadRequestException(Message.CREATE_FAILED);
			}
		}
		return modifier;
	}

	public async checkLikeExistence(input: LikeInput): Promise<MeLiked[]> {
		const { memberId, likeRefId } = input;
		const result = await this.likeModel.findOne({ memberId: memberId, likeRefId: likeRefId }).exec();
		return result ? [{ memberId: memberId, likeRefId: likeRefId, myFavorite: true }] : [];
	}

    public async getFavoriteWatches(memberId: ObjectId, input: OrdinaryInquiry): Promise<Watches> {
    const { page, limit } = input;
    const match: T = { likeGroup: LikeGroup.WATCH, memberId: memberId };

    const data: T = await this.likeModel
        .aggregate([
            { $match: match },
            { $sort: { updatedAt: -1 } },
            {
                $lookup: {
                    from: 'watches',
                    localField: 'likeRefId',
                    foreignField: '_id',
                    as: 'favoriteWatch',
                },
            },
            { $unwind: '$favoriteWatch' },
            {
                $facet: {
                    list: [
                        { $skip: (page - 1) * limit },
                        { $limit: limit },
                        lookupFavorite,
                        { $unwind: '$favoriteWatch.memberData' },
                    ],
                    metaCounter: [{ $count: 'total' }],
                },
            },
        ])
        .exec();

    const result: Watches = { list: [], metaCounter: data[0].metaCounter };
    result.list = data[0].list.map((ele) => ele.favoriteWatch);

    return result;
}

}
